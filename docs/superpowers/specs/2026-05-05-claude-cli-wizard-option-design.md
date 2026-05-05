# Opción `claude-cli` en el wizard de setup

**Fecha:** 2026-05-05
**Estado:** Spec aprobado por brainstorming
**Alcance:** aditivo — no rompe los tres paths SDK existentes
**Depende de:** [`2026-05-03-claude-cli-headless-provider-design.md`](./2026-05-03-claude-cli-headless-provider-design.md) — provider `claude-cli` ya implementado y registrado built-in.

## Resumen ejecutivo

El paso `auth` del wizard (`bash nanoclaw.sh`) hoy ofrece tres formas de conectar a Claude — todas terminan usando el provider `claude` (SDK) con OneCLI guardando el token. El provider `claude-cli` existe pero solo se activa editando `groups/<folder>/container.json` después del setup, lo que esconde una elección arquitectónica relevante (sin proxy, OAuth-only, single-turn-per-spawn) detrás de un paso manual.

Este cambio expone `claude-cli` como una **cuarta opción** en el menú de auth. Si el usuario la elige, el wizard verifica que el host tenga `claude` instalado y `~/.claude/.credentials.json`, escribe `NANOCLAW_DEFAULT_PROVIDER=claude-cli` en `.env`, y los scripts de creación de agentes (`init-cli-agent.ts`, `init-first-agent.ts`) propagan ese default al `container.json` de cada grupo nuevo.

No se modifica el provider, no se toca OneCLI, no se cambia el agent-runner. Es trabajo de `setup/` + dos scripts de bootstrap.

## Motivación

- Hoy un usuario que prefiere `claude-cli` tiene que: terminar el wizard SDK → entrar a Claude Code → editar `container.json` → reiniciar. Tres pasos manuales después de un onboarding "guiado".
- El path "subscription" del wizard ya corre `claude /login` internamente, así que el host queda con `~/.claude/.credentials.json` válido — el usuario podría haber usado `claude-cli` desde el primer spawn pero el wizard nunca se lo ofrece.
- Los trade-offs entre SDK y CLI provider son visibles y persistentes (afectan hooks, push mid-stream, manejo de credenciales). Pertenecen al menú de instalación, no a un archivo escondido.

## Estado actual relevante

- `setup/auto.ts:696-743` — `runAuthStep()`. Tres opciones (`subscription | oauth | api`) en un `brightSelect`. Branch en `runSubscriptionAuth()` o `runPasteAuth(method)`. Todas terminan llamando OneCLI para guardar el secret.
- `setup/auto.ts:697` — guardia idempotente `anthropicSecretExists()` que salta el step si ya hay secret en OneCLI.
- `setup/auto.ts:706-711` — rama custom-endpoint vía env vars `NANOCLAW_ANTHROPIC_BASE_URL` + `NANOCLAW_ANTHROPIC_AUTH_TOKEN`. Bypassa el menú y siempre usa SDK.
- `setup/auto.ts:896` — helper `writeEnvLine(key, value)`. Idempotente, soporta replace + append.
- `setup/register-claude-token.sh` — usado por `runSubscriptionAuth()`: instala `claude` si falta (vía `setup/install-claude.sh`), corre `claude /login`, registra el OAuth en OneCLI. La parte de OneCLI no se reusa aquí.
- `src/providers/claude-cli.ts:78-85` — `registerProviderContainerConfig('claude-cli', …)`. Ya verifica `~/.claude/.credentials.json` al spawn y lanza error claro si falta.
- `src/providers/index.ts:8` — `import './claude-cli.js';` ya está. El provider es built-in.
- `src/container-config.ts:33-50` — interface `ContainerConfig` con campo `provider?: string`. Default de código si está `undefined` es `claude` (SDK).
- `src/container-config.ts:114-119` — helper `updateContainerConfig(folder, mutate)`.
- `scripts/init-cli-agent.ts:108-114` — crea el agent group con `agent_provider: null`. Llama a `initGroupFilesystem(ag, …)` que escribe un `container.json` vacío.
- `scripts/init-first-agent.ts` — patrón equivalente para agentes wireados a canales reales.
- `agent_groups.agent_provider` (DB column) — separada de `container.json` `provider`. **No tocar** — el provider efectivo se resuelve desde el JSON, agregar lógica acá duplicaría fuentes de verdad.

## Decisiones tomadas (resumen del brainstorming)

| # | Decisión |
|---|---|
| 1 | La opción `claude-cli` aparece como **cuarta entrada** del `brightSelect` actual de auth, no como pregunta separada ni auto-detección. Una sola pregunta, copy explícito sobre el trade-off. |
| 2 | La elección persiste como **default global** en `.env` (`NANOCLAW_DEFAULT_PROVIDER=claude-cli`). Los scripts de creación leen esa env var y la propagan al `container.json` del grupo nuevo. Salida: editar `.env` o el `container.json` por grupo. |
| 3 | Si el usuario elige `cli` y falta `claude` o `~/.claude/.credentials.json`, el wizard **falla con mensaje claro** ("Run `claude /login` on the host first, then re-run setup"). No auto-instala ni abre browser. |
| 4 | La rama custom-endpoint (`NANOCLAW_ANTHROPIC_BASE_URL`) no cambia — sigue forzando SDK. `claude-cli` no soporta base URLs custom, así que son mutuamente excluyentes por construcción. |
| 5 | `agent_groups.agent_provider` (DB) no se toca. El provider se resuelve solo desde `container.json`. |

## Diseño detallado

### UX del menú de auth

El `brightSelect` de `runAuthStep()` (auto.ts:716-732) crece a cuatro opciones:

```
◆  How would you like to connect to Claude?
│  ○ Sign in with my Claude subscription          (recommended if you have Pro or Max)
│  ○ Use my host Claude Code CLI session          (OAuth-only, no proxy — requires `claude /login` on the host)
│  ○ Paste an OAuth token I already have          (sk-ant-oat…)
│  ○ Paste an Anthropic API key                   (pay-per-use via console.anthropic.com)
```

El nuevo `value: 'cli'` se agrega al type union (línea 734) y al switch que decide qué función auth invocar.

### Flujo `runHostCliAuth()` (función nueva)

Reemplaza la rama actual `await runPasteAuth(method)` para `method === 'cli'`. Pseudo-código:

```ts
async function runHostCliAuth(): Promise<void> {
  const start = Date.now();

  // 1. Verificar binario en PATH (spawn `command -v claude`, exit code 0 = ok).
  const claudeOnPath = await checkCommandExists('claude');
  if (!claudeOnPath) {
    setupLog.step('auth', 'failed', Date.now() - start, { METHOD: 'cli', REASON: 'cli-not-installed' });
    await fail(
      'auth',
      'Claude Code CLI not found on PATH.',
      'Install it from https://claude.ai/install.sh, run `claude /login`, then re-run setup.',
    );
  }

  // 2. Verificar credentials.
  const credsPath = path.join(os.homedir(), '.claude', '.credentials.json');
  if (!fs.existsSync(credsPath)) {
    setupLog.step('auth', 'failed', Date.now() - start, { METHOD: 'cli', REASON: 'host-not-logged-in' });
    await fail(
      'auth',
      'No host Claude login found.',
      'Run `claude /login` on the host first, then re-run setup.',
    );
  }

  // 3. Persistir el default.
  writeEnvLine('NANOCLAW_DEFAULT_PROVIDER', 'claude-cli');

  setupLog.step('auth', 'success', Date.now() - start, { METHOD: 'cli' });
  phEmit('auth_method_chosen', { method: 'cli' });
  p.log.success(brandBody('Host Claude CLI session detected.'));
}
```

### Idempotencia (re-run del wizard)

La guardia inicial actual (auto.ts:697):

```ts
if (anthropicSecretExists()) {
  p.log.success(brandBody('Your Claude account is already connected.'));
  setupLog.step('auth', 'skipped', 0, { REASON: 'secret-already-present' });
  return;
}
```

Se complementa con una nueva guardia paralela **antes** del menú:

```ts
const envDefault = readEnvLine('NANOCLAW_DEFAULT_PROVIDER');
const credsExist = fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'));
if (envDefault === 'claude-cli' && credsExist) {
  p.log.success(brandBody('Host Claude CLI session detected.'));
  setupLog.step('auth', 'skipped', 0, { REASON: 'cli-already-configured' });
  return;
}
```

Si `NANOCLAW_DEFAULT_PROVIDER=claude-cli` está en `.env` pero el credentials file desapareció (logout, máquina nueva, archivo borrado), **no** salta el step — se cae en el menú normal y el usuario re-elige.

`readEnvLine` es helper nuevo simétrico a `writeEnvLine`. Lectura simple del `.env` con regex; si no existe el archivo, devuelve `null`.

### Propagación del default al `container.json`

Después de cada `initGroupFilesystem(ag, …)` en los dos scripts:

```ts
import { updateContainerConfig } from '../src/container-config.js';
// …
const defaultProvider = process.env.NANOCLAW_DEFAULT_PROVIDER;
if (defaultProvider) {
  updateContainerConfig(ag.folder, (c) => {
    c.provider = defaultProvider;
  });
}
```

Si la env var no está, no se escribe el campo — `provider` queda `undefined` y el runner usa `claude` (SDK) por default.

Archivos:
- `scripts/init-cli-agent.ts` — después de la línea 120 (post `initGroupFilesystem`).
- `scripts/init-first-agent.ts` — patrón equivalente al final del bootstrap del grupo.

### Orden de evaluación en el step `auth`

```
1. anthropicSecretExists() → skip ('secret-already-present')
2. cliAlreadyConfigured() (.env flag === 'claude-cli' && credentials.json exists) → skip ('cli-already-configured')   ← NUEVO
3. customBaseUrl + customAuthToken → runCustomEndpointAuth() → return
4. brightSelect 4 opciones
5. switch (method) {
     'subscription' → runSubscriptionAuth()
     'cli'          → runHostCliAuth()                                  ← NUEVO
     'oauth' | 'api' → runPasteAuth(method)
   }
```

`anthropicSecretExists` corre **antes** de `cliAlreadyConfigured` para que una instalación migrada desde un setup SDK previo no quede atrapada en el path CLI.

### Comportamiento del Terminal Agent opcional

Cuando el usuario elige "Pause here and chat with your agent from the terminal" (auto.ts:391-395), el wizard llama `init-cli-agent.ts` por segunda vez con un nombre distinto. Como esa llamada hereda `process.env.NANOCLAW_DEFAULT_PROVIDER`, el Terminal Agent también arranca en `claude-cli`. Coherente con la elección — sin código adicional.

## Edge cases

| Caso | Comportamiento |
|---|---|
| Usuario elige `cli`, falta `claude` o `.credentials.json` | `fail()` con mensaje claro. Step queda `failed`. No se escribe `.env` ni se llama OneCLI. Claude-assist se ofrece igual que en otros fallos. |
| `claude /logout` después del setup, o refresh token vence | Out of scope del wizard. El provider lanza error al spawn; `host-sweep.ts` re-sincroniza credenciales periódicamente. Doc en `docs/claude-cli-provider.md` ya lo cubre. |
| Re-run del wizard con `.env` flag pero `.credentials.json` borrado | Guardia idempotente exige ambas condiciones — no salta el step. Vuelve al menú. |
| Mezcla SDK + CLI en una instalación | Soportado. `NANOCLAW_DEFAULT_PROVIDER` solo afecta agentes **nuevos**. Grupos existentes mantienen su `container.json`. Para volver un grupo a SDK: editar el JSON. |
| `NANOCLAW_ANTHROPIC_BASE_URL` + `NANOCLAW_DEFAULT_PROVIDER=claude-cli` | Custom-endpoint corre primero (auto.ts:706-711) y entra al flujo SDK. Conflicto solo si el usuario lo construye manualmente — sin validación cruzada (los dos paths son mutuamente excluyentes por env var). |
| Provider no soporta push mid-stream | El test ping y `pnpm run chat` son single-turn → encajan con `claude-cli`. Sin regresión. |
| Skills futuros que asuman SDK | Out of scope. Los hooks on-disk del provider `cli` cubren los casos actuales. Doc en `docs/claude-cli-provider.md`. |

## Lo que NO cambia

- `src/providers/claude-cli.ts` — provider completo, ya self-registrado.
- `src/container-config.ts` — `updateContainerConfig` y campo `provider` ya existen.
- `src/group-init.ts` — sigue creando un `container.json` vacío; el provider se setea por encima en los scripts.
- `setup/install-claude.sh` / `setup/register-claude-token.sh` — solo los usa el path subscription.
- OneCLI — la rama `cli` no la toca.
- `agent_groups` schema — `agent_provider` queda `null`, sin migrations.

## Archivos modificados (resumen)

| Archivo | Cambio |
|---|---|
| `setup/auto.ts` | Cuarta opción `'cli'` en el menú; `runHostCliAuth()`; nueva guardia idempotente; helper `readEnvLine()`. |
| `scripts/init-cli-agent.ts` | Lectura de `NANOCLAW_DEFAULT_PROVIDER` y escritura al `container.json` post `initGroupFilesystem`. |
| `scripts/init-first-agent.ts` | Mismo patrón. |
| `docs/claude-cli-provider.md` | Sección breve "Activate via setup wizard". |
| `CLAUDE.md` | Bullet en built-in providers: el wizard ahora elige `claude-cli` directo. |

## Tests propuestos

- **Bajo costo, alto retorno:** test focalizado en `init-cli-agent.ts` — con `NANOCLAW_DEFAULT_PROVIDER=claude-cli` seteado, verificar que `container.json` queda con `provider: "claude-cli"`. Sin la env var, queda sin el campo.
- **Si ya existe suite del step auth:** agregar caso `cli` happy path (mocks de `which` y `fs.existsSync`) y caso falla por creds faltantes. Si no existen tests del step, no inventamos uno por este cambio — el wizard ya tiene cobertura via tests E2E manuales del onboarding.

## Versionado sugerido

Minor (`v2.x.0`) — feature aditiva. Compatible hacia atrás: una instalación existente que re-corra setup no pierde nada (la guardia `anthropicSecretExists()` corre primero). Sin migrations.
