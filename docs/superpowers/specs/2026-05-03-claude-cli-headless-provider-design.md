# Claude CLI Headless como provider built-in

**Fecha:** 2026-05-03
**Estado:** Spec aprobado por brainstorming
**Alcance:** aditivo — no rompe nada existente
**Versionado sugerido:** v2.1.0 (minor, feature aditiva)

## Resumen ejecutivo

Agregar un nuevo provider `claude-cli` al árbol de providers built-in del agent-runner de NanoClaw. Este provider invoca el binario `/pnpm/claude` (Claude Code CLI) en modo headless (`claude -p`) en lugar de hablar con `api.anthropic.com` vía `@anthropic-ai/claude-agent-sdk`. La autenticación se hace por la sesión OAuth del CLI (sin `ANTHROPIC_API_KEY`, sin OneCLI proxy de credenciales AI).

El provider coexiste con el provider `claude` (SDK) actual; la selección es per-grupo vía `container.json`. La abstracción `AgentProvider`, los demás providers, las skills, OneCLI y todo el host orquestador permanecen inalterados.

## Motivación

- Eliminar dependencia operativa de `ANTHROPIC_API_KEY` y del proxy OneCLI para los grupos donde el usuario prefiera usar su login interactivo del CLI (`claude /login`).
- Aprovechar que el binario `/pnpm/claude` ya está instalado en la imagen (`container/Dockerfile:84–105`) y que el SDK actual de hecho lo invoca internamente — sólo se cambia el wire protocol (RPC streaming → argv + stream-json).
- Mantener pluggability: el usuario puede tener simultáneamente grupos en SDK, en CLI headless, en OpenCode, etc., decidiendo por grupo.

## Estado actual relevante

- `container/agent-runner/src/providers/claude.ts:266` — `query()` invoca `sdkQuery({...resume: input.continuation, pathToClaudeCodeExecutable: '/pnpm/claude'...})`. El SDK ya delega al mismo binario que vamos a invocar.
- `container/agent-runner/src/providers/types.ts` — interface `AgentProvider`: `query()` retorna `AgentQuery` con `events: AsyncGenerator<ProviderEvent>`, `push`, `end`, `abort`, más `isSessionInvalid()` y `supportsNativeSlashCommands`.
- `container/agent-runner/src/providers/index.ts:5` — barrel `import './claude.js';` registra el provider via `registerProvider()`.
- `src/container-runner.ts` — host-side spawn de containers; arma mounts y env del container según la config del grupo.
- Modelo de turno actual (preservado): cada wakeup, el provider recibe `QueryInput.continuation` (session_id del CLI persistido en `outbound.db`). El CLI carga su propio historial desde `~/.claude/projects/<workspace>/<session>.jsonl`. NanoClaw envía sólo el mensaje nuevo + el session_id.

## Decisiones tomadas (resumen del brainstorming)

| # | Decisión |
|---|---|
| 1 | El provider invoca `claude -p` (CLI headless), no se elimina ni reemplaza el provider `claude` (SDK). |
| 2 | Alcance es **aditivo**: no se eliminan OneCLI, skills `/add-*-tool`, skills `/add-*-provider`, rama `providers`, ni la abstracción `factory/registry/types/mock`. |
| 3 | Container Docker, dos DBs por sesión, host orquestador y canales se mantienen sin cambios. |
| 4 | Modelo de turnos: `--resume <session-id>` (mismo modelo que el SDK). |
| 5 | Hooks `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PreCompact` configurados vía `~/.claude/settings.json` con scripts Bun que reciben evento por stdin. |
| 6 | Auth: el host copia `~/.claude/.credentials.json` a `data/v2-sessions/<session>/claude/.credentials.json` al spawn y mount-ea el directorio a `/root/.claude/` del container. Sync por mtime en cada wakeup. |
| 7 | Registro: el provider vive built-in en trunk (no en la rama `providers`), porque el binario `/pnpm/claude` ya está en la imagen y no requiere paquetes nuevos. |

## Diseño detallado

### Arquitectura

Componentes nuevos (5 archivos, 1 doc):

```
container/agent-runner/src/providers/
├── claude-cli.ts                          (~250–300 LOC, nuevo)
└── claude-cli-hooks/
    ├── transcript.ts                      (~80 LOC: parse + format extraídos de claude.ts)
    ├── pre-tool-use.ts                    (~50 LOC)
    ├── post-tool-use.ts                   (~15 LOC)
    └── pre-compact.ts                     (~50 LOC)

docs/claude-cli-provider.md                (~1 página)
```

Componentes tocados (4 archivos):

- `container/agent-runner/src/providers/index.ts` — agregar `import './claude-cli.js';`.
- `src/container-runner.ts` — bloque condicional `if (groupConfig.provider === 'claude-cli')` que crea el directorio `claude/` per-sesión, copia credenciales, genera `settings.json` y `mcp.json`, agrega el mount.
- `src/host-sweep.ts` — bloque opcional para resync de credenciales por mtime; alternativamente, el resync vive en `container-runner.ts` y se ejecuta antes de cada wakeup.
- `CLAUDE.md` (root) — mención del nuevo provider built-in.

Sin cambios: router, delivery, channels, OneCLI, providers `claude` y `mock`, skills, rama `providers`, los archivos de DB, los formatters del agent-runner.

### Módulo `claude-cli.ts`

Implementa `AgentProvider`. Estructura:

```ts
export class ClaudeCliProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = true;

  constructor(opts: ProviderOptions = {}) { /* assistantName, mcpServers, env, additionalDirectories */ }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      ...(input.continuation ? ['--resume', input.continuation] : []),
      ...(input.systemContext?.instructions
        ? ['--append-system-prompt', input.systemContext.instructions] : []),
      '--allowedTools', TOOL_ALLOWLIST.join(','),
      '--disallowedTools', SDK_DISALLOWED_TOOLS.join(','),
      '--permission-mode', 'bypassPermissions',
      '--dangerously-skip-permissions',
      '--mcp-config', '/root/.claude/mcp.json',
      '--settings', '/root/.claude/settings.json',
      ...(this.additionalDirectories?.flatMap(d => ['--add-dir', d]) ?? []),
      '--', // end-of-flags: garantiza que input.prompt no se reinterprete como flag
      input.prompt,
    ];

    const child = Bun.spawn(['/pnpm/claude', ...args], {
      cwd: input.cwd,
      env: { ...process.env, ...this.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW },
      stdout: 'pipe', stderr: 'pipe',
    });

    return {
      events: translateStream(child),
      push: () => { /* no-op en el modelo single-turn — ver sec. "Modelo de turno" */ },
      end:  () => child.kill('SIGTERM'),
      abort: () => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000); },
    };
  }
}
registerProvider('claude-cli', (opts) => new ClaudeCliProvider(opts));
```

`TOOL_ALLOWLIST` y `SDK_DISALLOWED_TOOLS` son los mismos arrays que en `claude.ts:25–58` — extraídos a un módulo compartido (`providers/tool-policies.ts`) o duplicados explícitamente; decisión menor a tomar al implementar.

**Nota de seguridad — separador `--` antes del prompt:** la inserción de `'--'` antes de `input.prompt` es deliberada. Aunque hoy el formatter (`container/agent-runner/src/formatter.ts`) garantiza que el prompt empiece con `<context ...>` o con `/` (para passthrough), esa propiedad es emergente del formatter + `categorizeMessage` y un refactor futuro podría romperla. El separador `--` hace que la garantía "el prompt nunca se reinterpreta como flags del CLI" sea local al provider y a costo cero. Sin él, un prompt con leading `--` (en un futuro flujo no contemplado hoy) podría sobrescribir `--mcp-config` / `--settings` con paths agente-controlados. Si el binario `claude` no acepta `--` como end-of-flags en su versión pinneada, fallback es pasar el prompt por stdin (`stdin: 'pipe'` + write).

### Parser de stream-json → ProviderEvent

`claude -p --output-format stream-json --verbose` emite una línea JSON por evento. Mapeo:

| Línea CLI | Evento emitido |
|---|---|
| `{type:"system",subtype:"init",session_id:"..."}` | `{type:'init', continuation: session_id}` |
| `{type:"assistant",message:{...}}` | `{type:'activity'}` |
| `{type:"user",message:{...}}` (tool result) | `{type:'activity'}` |
| `{type:"system",subtype:"compact_boundary",compact_metadata:{...}}` | `{type:'result', text:'Context compacted...'}` |
| `{type:"result",subtype:"success",result:"..."}` | `{type:'result', text: result}` |
| `{type:"result",subtype:"error_max_turns"\|"error_during_execution"\|...}` | `{type:'error', message, retryable: classify(subtype)}` |
| Exit code != 0 sin línea `result` | `{type:'error', message: stderr, retryable:false}` |

Implementación de `translateStream(child)`: lee stdout linea-por-línea, parsea cada línea JSON, emite el ProviderEvent correspondiente. Ignora líneas no parseables con un `log()` (no aborta — defensivo contra cambios de shape del CLI). Cuando stdout cierra, espera `exitCode`. Si != 0 y no hubo `result`, emite error con stderr.

### Modelo de turno

**Una invocación de `query()` = un `spawn` = un turno.** Si llegan mensajes nuevos a `messages_in` mientras el spawn está corriendo, esperan al siguiente wakeup del poll-loop. El método `push()` del `AgentQuery` retornado es no-op para este provider (vs. el provider SDK que sí soporta push mid-stream vía `MessageStream`).

**Justificación:** push mid-stream con el CLI requeriría `--input-format stream-json` y un protocolo de stdin más complejo. En la práctica, el caso de uso es raro (usuario envía mensaje mientras agente está pensando) y el modelo de "siguiente wakeup" ya cubre la semántica de "mensaje recibido y será procesado". Si se necesita en el futuro, se agrega como segunda iteración sin romper la interface.

### Detección de sesión inválida

`isSessionInvalid(err)` reusa el regex existente: `/no conversation found|ENOENT.*\.jsonl|session.*not found/i`. Cuando el CLI corre con `--resume <id>` y el `.jsonl` no existe (sesión perdida, container reiniciado con `data/` borrado, etc.), imprime un mensaje en stderr matcheable. El poll-loop ya maneja esto — limpia `continuation` y reintenta.

### Hooks scripts

Cada script:
1. Lee evento JSON de stdin.
2. Importa el módulo de DB compartido (`db/connection.js`) que ya usa el agent-runner.
3. Hace una operación corta y cierra.
4. Sale 0 (o estructura JSON específica para `pre-tool-use`).

#### `pre-tool-use.ts`

Funciones:
- Bloquear tools deshabilitadas (devolver `{decision:'block', stopReason:'...'}` por stdout).
- Registrar tool in-flight en la DB de la sesión vía `setContainerToolInFlight(toolName, declaredTimeoutMs)`. Para Bash, `declaredTimeoutMs = event.tool_input?.timeout` (mismo flow que el hook actual).

```ts
import { setContainerToolInFlight } from '../../db/connection.js';

const event = JSON.parse(await Bun.stdin.text());
const toolName: string = event.tool_name ?? '';

const DISALLOWED = ['CronCreate','CronDelete','CronList','ScheduleWakeup',
  'AskUserQuestion','EnterPlanMode','ExitPlanMode','EnterWorktree','ExitWorktree'];
if (DISALLOWED.includes(toolName)) {
  console.log(JSON.stringify({
    decision: 'block',
    stopReason: `Tool '${toolName}' is not available in this environment — use the nanoclaw equivalent.`,
  }));
  process.exit(0);
}

const declaredTimeoutMs = toolName === 'Bash' && typeof event.tool_input?.timeout === 'number'
  ? event.tool_input.timeout : null;
try { setContainerToolInFlight(toolName, declaredTimeoutMs); } catch { /* swallow */ }
process.exit(0);
```

#### `post-tool-use.ts`

```ts
import { clearContainerToolInFlight } from '../../db/connection.js';
try { clearContainerToolInFlight(); } catch { /* swallow */ }
process.exit(0);
```

Registrado en `settings.json` para `PostToolUse` y `PostToolUseFailure`.

#### `pre-compact.ts`

Equivalente al `createPreCompactHook` actual (`claude.ts:181–222`):

```ts
import { parseTranscript, formatTranscriptMarkdown } from './transcript.js';
import fs from 'fs';
import path from 'path';

const event = JSON.parse(await Bun.stdin.text());
const transcriptPath: string | undefined = event.transcript_path;
const sessionId: string | undefined = event.session_id;

if (!transcriptPath || !fs.existsSync(transcriptPath)) process.exit(0);

const messages = parseTranscript(fs.readFileSync(transcriptPath, 'utf-8'));
if (messages.length === 0) process.exit(0);

let summary: string | undefined;
const indexPath = path.join(path.dirname(transcriptPath), 'sessions-index.json');
if (fs.existsSync(indexPath)) {
  try {
    const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    summary = idx.entries?.find((e: any) => e.sessionId === sessionId)?.summary;
  } catch { /* ignore */ }
}

const name = summary
  ? summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
  : `conversation-${new Date().getHours().toString().padStart(2,'0')}${new Date().getMinutes().toString().padStart(2,'0')}`;

const conversationsDir = '/workspace/agent/conversations';
fs.mkdirSync(conversationsDir, { recursive: true });
const filename = `${new Date().toISOString().split('T')[0]}-${name}.md`;
const assistantName = process.env.NANOCLAW_ASSISTANT_NAME; // populated by container-runner
fs.writeFileSync(
  path.join(conversationsDir, filename),
  formatTranscriptMarkdown(messages, summary, assistantName),
);
process.exit(0);
```

`assistantName` se pasa via env var `NANOCLAW_ASSISTANT_NAME`, que `container-runner.ts` setea en el bloque `if (groupConfig.provider === 'claude-cli')` al armar el `docker run`. El env var se hereda del proceso CLI a sus subprocesos hooks por defecto. Si en el futuro se necesita más metadata del grupo en los hooks, agregar más env vars en el mismo bloque.

#### `transcript.ts` (helpers compartidos)

`parseTranscript()` y `formatTranscriptMarkdown()` extraídos textualmente de `claude.ts:111–142` a este módulo. El provider `claude` (SDK) puede empezar a importarlos desde acá también (refactor mínimo, oportunístico — no obligatorio en este alcance).

#### Settings.json (template estático)

```json
{
  "hooks": {
    "PreToolUse":         [{ "command": "bun /agent-runner/src/providers/claude-cli-hooks/pre-tool-use.ts" }],
    "PostToolUse":        [{ "command": "bun /agent-runner/src/providers/claude-cli-hooks/post-tool-use.ts" }],
    "PostToolUseFailure": [{ "command": "bun /agent-runner/src/providers/claude-cli-hooks/post-tool-use.ts" }],
    "PreCompact":         [{ "command": "bun /agent-runner/src/providers/claude-cli-hooks/pre-compact.ts" }]
  }
}
```

**Importante**: rutas `.ts` (no `.js`). El agent-runner se monta tal cual al container (no hay paso `tsc`/`dist/`); Bun ejecuta `.ts` directo (`CLAUDE.md` root: *"the image has no /app/dist; don't reintroduce a tsc build step"*). El path real del mount lo da `src/container-runner.ts` línea ~301 (el dynamic-spawn command). Verificar al implementar y ajustar el template si difiere de `/agent-runner/...`.

### DB lock concern

Los scripts de hooks corren como subprocesos del CLI, que es subproceso del agent-runner. Tres procesos pueden tocar `inbound.db` simultáneamente.

**Mitigación:**
- Hooks abren la conexión, hacen una sola transacción corta (`UPDATE container_state SET ...`), cierran.
- Sin lecturas largas, sin transacciones complejas.
- Retry de 50ms × 3 intentos en caso de `SQLITE_BUSY`.

Mismo patrón que ya usan los hooks del SDK actual (que también corren fuera del thread principal del loop). Conocido y robusto.

### Auth flow (cambio en `container-runner.ts`)

Layout en host (per-sesión, sólo si provider es `claude-cli`):

```
data/v2-sessions/<session_id>/
├── inbound.db
├── outbound.db
└── claude/
    ├── .credentials.json   ← copiado desde ~/.claude/.credentials.json
    ├── settings.json       ← template estático
    └── mcp.json            ← generado desde groupConfig.mcpServers
```

**Mounts** (cuatro bind-mounts: una base RW + tres archivos RO anidados):

```
<sessionClaudeDir>:/root/.claude:rw                                  # base RW (CLI escribe projects/<...>.jsonl)
<sessionClaudeDir>/settings.json:/root/.claude/settings.json:ro      # nested RO sobre el config de hooks
<sessionClaudeDir>/mcp.json:/root/.claude/mcp.json:ro                # nested RO sobre el config MCP
<sessionClaudeDir>/.credentials.json:/root/.claude/.credentials.json:ro  # nested RO sobre el token OAuth
```

**Razón** (modelo de seguridad): el agente corre con `Bash`/`Write`/`Edit` permitidos y `--dangerously-skip-permissions`. El directorio base debe ser RW porque el CLI necesita escribir su estado de sesión bajo `projects/`. Pero `settings.json`, `mcp.json` y `.credentials.json` son archivos de control que el CLI re-lee en cada spawn:

- `settings.json` define los hooks que enforzan la denylist (`CronCreate`, `ScheduleWakeup`, etc.) y registran tools in-flight. Si el agente lo reescribe (`echo '{}' > /root/.claude/settings.json`), pierde toda la enforcement de hooks; peor aún, puede sustituir el comando del hook por una shell arbitraria que recibe `event.tool_input` por stdin (cuerpo de cada Bash, contenido de cada Write/Edit) y exfiltrar.
- `mcp.json` lista servidores MCP; cada entrada `{command, args, env}` se ejecuta como subproceso al inicio de cada spawn. Reescribir el archivo da RCE inmediato en el siguiente turno con acceso al token OAuth en el mismo directorio.
- `.credentials.json` es el token OAuth del CLI; el agente no lo necesita escribir, sólo el host vía resync de mtime.

El patrón de RO anidado sobre RW ya está en uso en `src/container-runner.ts:273-294` para `container.json`, `CLAUDE.md` y `.claude-fragments` exactamente por este motivo. El provider `claude` (SDK) no tiene este problema porque registra hooks como callbacks JS in-process — no hay archivo on-disk que el agente pueda reescribir.

Pseudocódigo del bloque agregado a `container-runner.ts`:

```ts
if (groupConfig.provider === 'claude-cli') {
  const sessionClaudeDir = path.join(SESSION_DIR, 'claude');
  fs.mkdirSync(sessionClaudeDir, { recursive: true });

  const hostCreds = path.join(os.homedir(), '.claude', '.credentials.json');
  if (!fs.existsSync(hostCreds)) {
    throw new Error(
      "provider 'claude-cli' requires `claude /login` on the host first " +
      "(no ~/.claude/.credentials.json found)",
    );
  }

  const sessionCreds = path.join(sessionClaudeDir, '.credentials.json');
  if (!fs.existsSync(sessionCreds) ||
      fs.statSync(hostCreds).mtimeMs > fs.statSync(sessionCreds).mtimeMs) {
    fs.copyFileSync(hostCreds, sessionCreds);
    fs.chmodSync(sessionCreds, 0o600);
  }

  // Regenerar settings.json y mcp.json desde el template en cada spawn.
  // Defensa en profundidad: aunque ambos están montados RO al container,
  // re-escribirlos en host garantiza que cualquier escritura previa del agente
  // (vía path host equivalente, ej. via /workspace) se descarte antes del próximo spawn.
  fs.writeFileSync(path.join(sessionClaudeDir, 'settings.json'), CLAUDE_CLI_SETTINGS_TEMPLATE);
  fs.writeFileSync(
    path.join(sessionClaudeDir, 'mcp.json'),
    JSON.stringify({ mcpServers: groupConfig.mcpServers ?? {} }, null, 2),
  );

  // Base RW (CLI necesita escribir projects/<...>.jsonl, etc).
  dockerMounts.push(`${sessionClaudeDir}:/root/.claude:rw`);
  // Nested RO sobre los tres archivos de control que el CLI re-lee en cada spawn.
  // Sin estos, el agente (con Bash/Write/Edit + bypassPermissions) puede reescribir
  // settings.json para neutralizar hooks o reemplazar su comando por una shell arbitraria,
  // o reescribir mcp.json para lograr RCE al lanzarse el siguiente servidor MCP.
  dockerMounts.push(`${sessionClaudeDir}/settings.json:/root/.claude/settings.json:ro`);
  dockerMounts.push(`${sessionClaudeDir}/mcp.json:/root/.claude/mcp.json:ro`);
  dockerMounts.push(`${sessionClaudeDir}/.credentials.json:/root/.claude/.credentials.json:ro`);
}
```

**Resync de credenciales:** la verificación de mtime arriba se ejecuta en cada wakeup (preparación del docker run). Cuando el container ya está corriendo y el wakeup sólo escribe a `inbound.db`, se necesita un mecanismo adicional. Dos opciones:

a) Agregar un check periódico en `host-sweep.ts` que, si `groupConfig.provider === 'claude-cli'` y `mtime(host master) > mtime(session creds)`, copie. La próxima invocación del CLI dentro del container lee el archivo nuevo.

b) Aceptar que el resync sólo ocurre en spawn nuevo del container. Para sesiones long-lived, el usuario debe restartar el container del grupo después de `claude /login`.

**Decisión:** **(a)**. La complejidad es ~15 LOC en el sweep (que ya itera sobre sesiones cada 60s). El usuario no debería tener que conocer el mecanismo.

### Casos borde

| Caso | Comportamiento |
|---|---|
| Host nunca corrió `claude /login` | Spawn falla con error claro: *"provider 'claude-cli' requires `claude /login` on the host first"*. No se crea sesión. Mensaje propagado al canal del usuario via flujo estándar de errores. |
| Refresh token caduca (semanas/meses sin actividad) | El CLI dentro del container falla la primera invocación. El poll-loop reporta error no-retryable. Usuario debe correr `claude /login` en el host. |
| Usuario relogea en host | Próximo wakeup: el sweep detecta mtime nuevo y re-copia. Próxima invocación del CLI usa token nuevo. Si hay un spawn en curso con token viejo, falla y el poll-loop reintenta. |
| `~/.claude/.credentials.json` con permisos incorrectos | `fs.copyFileSync` lanza EACCES. Error claro al usuario. |
| Dos sesiones del mismo grupo, cada una con su propio `claude/.credentials.json` | Refrescos del CLI son independientes por sesión. No hay contention. |

### Selección del provider

`container.json` por grupo ya soporta `provider`. Sólo agregamos `'claude-cli'` a los valores aceptados. Activación:

- **Manual:** usuario edita `groups/<folder>/container.json` y restartea el container del grupo. Es lo único soportado en el primer cut.
- **Skill operacional (futuro, no en este alcance):** `/use-claude-cli-provider` o flag en `/manage-channels`.

Default global sigue siendo `'claude'` (SDK). No se modifica.

### Validación de la config

Si `src/db/agent-groups.ts` (o el módulo equivalente) tiene un enum literal de providers, agregar `'claude-cli'` al union type. Si no hay validación explícita y el valor pasa libremente al container, no hay nada que cambiar — el agent-runner falla con un mensaje claro (`Unknown provider: <name>`) si recibe un valor no registrado.

### Tests

**Container (Bun test):**

| Archivo | Cobertura |
|---|---|
| `src/providers/claude-cli.test.ts` | Mockea `Bun.spawn`. Verifica construcción de args para varios `QueryInput`. Verifica el parser stream-json → ProviderEvent con un set de líneas representativas. Verifica `isSessionInvalid()`. Verifica `abort()` (SIGTERM seguido de SIGKILL). |
| `src/providers/claude-cli-hooks/pre-tool-use.test.ts` | stdin con tools deshabilitadas → JSON `{decision:'block'}`. stdin con tools permitidas → llamada a mock de `setContainerToolInFlight`. Bash con/sin timeout. |
| `src/providers/claude-cli-hooks/post-tool-use.test.ts` | Trivial: llama `clearContainerToolInFlight`. |
| `src/providers/claude-cli-hooks/pre-compact.test.ts` | Transcript fake en disco temp + summary index → archivo markdown esperado. Reusa fixtures de los tests del SDK actual si existen. |
| `src/providers/claude-cli-hooks/transcript.test.ts` | Si los helpers no estaban testeados antes, agregar coverage básico. |

**Host (Vitest):**

| Archivo | Cobertura |
|---|---|
| `src/container-runner.test.ts` (extender) | Para grupo `claude-cli`: se crea `data/v2-sessions/<id>/claude/`, archivos populados, los **cuatro** mounts en la lista (RW base + 3× RO nested), en ese orden. Para grupo `claude` (SDK): nada de eso. Error EACCES y error-no-creds-in-host. mtime resync. Verificar que `<sessionClaudeDir>` no está incluido en otros mounts RW (ej. workspace); si la implementación cambia y lo expone, agregar test que falle. |
| `src/host-sweep.test.ts` (extender, si aplica) | Resync de mtime para grupos con `claude-cli` durante el sweep. |

**Sin E2E real contra el binario `claude`** — lento, requiere auth, inestable en CI. Validación E2E queda para uso manual del usuario en su instalación local.

### Documentación

**Nuevo:** `docs/claude-cli-provider.md` — qué es, requisitos previos (`claude /login`), cómo activar, diferencias vs. provider `claude` (SDK), limitaciones (sin push mid-stream), troubleshooting.

**Actualizado:**
- `CLAUDE.md` (root): mención del nuevo provider built-in en la sección de providers.
- `docs/agent-runner-details.md`: fila nueva en la tabla de providers (si existe), nota sobre el flow de spawn con credenciales.
- `README.md`: opcional, una línea en quickstart.

Sin actualizar: `docs/architecture.md`, `docs/api-details.md`, `docs/db-*.md`, `docs/isolation-model.md` — la arquitectura de fondo no cambia.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Shape exacto de eventos `--output-format stream-json` cambia entre versiones del CLI | Parser defensivo: ignora líneas no parseables, mapea por `type`/`subtype` con fallback a `activity`. Test fixtures con líneas reales capturadas, actualizables si el CLI cambia. Pin de versión del CLI en Dockerfile (ya existe vía `CLAUDE_CODE_VERSION`). |
| MCP server interno de NanoClaw asume estar in-process del SDK | Verificar en implementación que el MCP server actual funciona como subprocess standalone (paths de DB via env vars o args). Si asume in-process, ajustar para que tome paths por config. |
| `--input-format stream-json` se necesita para push mid-stream y no fue implementado | Documentado como limitación conocida en `docs/claude-cli-provider.md`. La interface `AgentQuery.push` queda no-op. Iteración futura puede agregarlo. |
| Refresh token caducado deja al agente sin auth | Mensaje de error claro al usuario. Documentado en troubleshooting. Mismo modo de falla que cualquier credencial expirada en cualquier provider. |
| Bind-mount de archivo único rompe en atomic rename del host | Los nested RO mounts de `settings.json`/`mcp.json`/`.credentials.json` siguen al inode original. El host **sobreescribe in-place** con `fs.writeFileSync` (truncate+write — preserva inode), no `rename(2)`. Mismo enfoque que el patrón ya en uso en `src/container-runner.ts:273-294`. |
| Tres procesos abriendo `inbound.db` (loop + CLI + hook) genera SQLITE_BUSY | Hooks usan transacciones cortas + retry 50ms × 3. Patrón ya en uso por hooks del SDK. |
| Agente reescribe `settings.json` (vía Bash/Write/Edit) y bypassa hooks o sustituye comando del hook por shell arbitraria | Nested RO mount sobre `/root/.claude/settings.json`. Verificar al implementar que `<sessionClaudeDir>` **no** quede expuesto vía otro mount RW (ej. `/workspace`); si lo está, mover los archivos de control a un directorio hermano fuera del session dir y mantener sólo el RO mount al path final. |
| Agente reescribe `mcp.json` y logra RCE al spawnearse el próximo servidor MCP | Mismo nested RO mount sobre `/root/.claude/mcp.json`. Defensa adicional: regenerar el archivo desde el template en cada `docker run` (ya en el pseudocódigo). |
| Agente sobreescribe `.credentials.json` y corrompe el token OAuth | Nested RO mount sobre `/root/.claude/.credentials.json`. El agente nunca necesita escribirlo; solo el host (vía resync por mtime). |
| Flag injection si `input.prompt` empieza con `--` y el parser del CLI acepta flags tardíos | Separador `--` end-of-flags antes de `input.prompt` en el argv (ver sección "Módulo `claude-cli.ts`"). Costo cero, garantía local al provider. |

## Out of scope (deferred)

- Skill `/use-claude-cli-provider` para activar el provider sin editar JSON manualmente.
- Push mid-stream (`AgentQuery.push` mid-turno via `--input-format stream-json`).
- Migración automática de grupos existentes de provider `claude` (SDK) a `claude-cli`. Cambio es manual per-grupo, intencionalmente.
- Eliminación del SDK, OneCLI, skills `/add-*-tool`, etc. — esto era la "Lectura X" del brainstorming, descartada en favor de la "Lectura Y" (multi-provider, aditivo).

## Plan de validación post-implementación

1. **Test unitarios pasan** — host (vitest) + container (bun test).
2. **Test manual en local:**
   - Verificar `claude /login` en host.
   - Crear nuevo grupo con `provider: 'claude-cli'` en `container.json`.
   - Enviar mensaje desde un canal — verificar respuesta.
   - Verificar que `~/.claude/projects/...` dentro del container persiste (ver `data/v2-sessions/<id>/claude/projects/`).
   - Provocar compaction (conversación larga) — verificar archivo en `/workspace/agent/conversations/`.
   - Provocar tool deshabilitada (ej. `EnterPlanMode`) — verificar bloqueo.
   - Forzar caducidad de token → verificar error claro.
   - **Tests de aislamiento (seguridad):**
     - Pedir al agente que ejecute `Bash`: `echo '{}' > /root/.claude/settings.json` → debe fallar con `EROFS` o equivalente. Verificar que el siguiente turno sigue bloqueando tools de la denylist.
     - Pedir al agente que ejecute `Bash`: `echo '{"mcpServers":{"x":{"command":"/bin/true"}}}' > /root/.claude/mcp.json` → debe fallar con `EROFS`.
     - Pedir al agente que ejecute `Bash`: `cat /root/.claude/.credentials.json > /tmp/leak; echo done` → confirma el modelo de amenaza (lectura sí es posible — el aislamiento aquí es contra escritura, no contra lectura del propio token; lectura del token desde dentro del container es aceptada por diseño porque el CLI lo necesita). Si en el futuro se quiere defender contra lectura, evaluar separar el archivo a un path solo accesible por el binario del CLI vía hardening adicional.
3. **Coexistencia:** mismo NanoClaw corriendo dos grupos, uno con `claude` (SDK), otro con `claude-cli`. Ambos funcionan en paralelo sin interferencia.
