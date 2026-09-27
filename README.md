# Generación progresiva con SSE

Aplicación universitaria que transmite respuestas de OpenAI desde una API NestJS al navegador de forma progresiva, con cancelación independiente por solicitud.

## Tecnologías

NestJS, TypeScript, pnpm, SDK oficial de OpenAI, `@nestjs/config`, `class-validator`, `class-transformer`, HTML, CSS y JavaScript vanilla.

## Instalación y configuración

Requiere Node.js 22 o superior y pnpm. Desde la raíz del proyecto, en PowerShell:

```powershell
pnpm.cmd install
if (!(Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

Configura `OPENAI_API_KEY` con tu credencial exclusivamente en el archivo local `.env`. El modelo se configura mediante `OPENAI_MODEL`; la plantilla utiliza `gpt-5.6-luna`. Debes tener acceso al modelo elegido. Si `.env` ya existe, completa las variables sin sobrescribir otras configuraciones. Reinicia el servidor después de cambiarlas.

La clave permanece exclusivamente en el backend y se obtiene mediante `ConfigService`. No se envía al navegador, no está escrita en el código y no se registra en logs. `.env` está incluido en `.gitignore`; `.env.example` contiene la variable de clave vacía y puede versionarse.

Sin clave o modelo, el servidor arranca pero la generación devuelve HTTP 503 con un mensaje genérico, sin revelar configuración ni trazas internas.

## Ejecución

```powershell
pnpm.cmd run start:dev
```

Abre <http://localhost:3001>. En PowerShell se usa `pnpm.cmd` para evitar el bloqueo del lanzador `.ps1`; en otras terminales puedes usar `pnpm`.

Para compilar y ejecutar la compilación, detén antes el servidor de desarrollo:

```powershell
pnpm.cmd run build
pnpm.cmd run start:prod
```

Conserva `public/` junto a `dist/` en la raíz del proyecto.

## Endpoint y streaming SSE

`POST /api/generate` recibe JSON:

```json
{"message":"Explica cinco características de HTTP."}
```

El mensaje es obligatorio, debe ser texto no vacío después de normalizar espacios y admite hasta 2000 caracteres. Las propiedades adicionales se rechazan con HTTP 400.

El backend utiliza OpenAI Responses API con streaming y responde con `Content-Type: text/event-stream; charset=utf-8`. Cada delta real de OpenAI se transforma inmediatamente en un evento SSE `content`. El servidor no acumula la respuesta completa ni simula fragmentos.

El navegador utiliza `fetch` POST y un lector incremental. El parser conserva eventos incompletos entre chunks y agrega cada delta al área de respuesta como texto. Los eventos `status` actualizan el estado; `completed` indica finalización y cierra la conexión sin repetir la respuesta completa. Los errores usan mensajes seguros y conservan el texto parcial.

## Estados y cancelación

- **Esperando:** solicitud enviada, antes del primer delta.
- **Generando:** se recibe y muestra texto progresivamente.
- **Completado:** OpenAI confirmó la finalización.
- **Interrumpido:** el usuario pulsó Detener y se conserva el texto recibido.

Mientras se genera, Generar está deshabilitado y Detener habilitado. Detener utiliza el `AbortController` de esa generación para cancelar fetch. El backend detecta el cierre prematuro de la respuesta HTTP y aborta la señal asociada al stream de OpenAI. Una finalización normal no se considera una interrupción.

Al terminar, interrumpir o fallar, se liberan los recursos y Generar vuelve a habilitarse. Una cancelación intencional no se muestra como error. Una ejecución anterior no puede modificar la interfaz de una generación posterior.

## Aislamiento de solicitudes simultáneas

Cada llamada al endpoint mantiene localmente su mensaje, respuesta HTTP, stream, `AbortController` y estados de cancelación y finalización. El controller no conserva objetos HTTP entre llamadas y el service no almacena datos de una generación en propiedades de clase. El cliente OpenAI se reutiliza; sus solicitudes usan señales independientes.

Cada pestaña mantiene su propio controlador activo y su propia respuesta visible. Cancelar una solicitud aborta únicamente su señal y su conexión: las otras solicitudes continúan con sus respectivos streams.
