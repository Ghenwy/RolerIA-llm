# Instalar RolerIA llm

Alpha experimental: consulta [limitaciones](ALPHA_STATUS.md). Esta guía no contiene información del equipo del mantenedor, sus pruebas ni sus configuraciones reales.

## 1. Requisitos

- Windows y PowerShell 7.
- Node.js 24, compatible con Node.js 22; npm y Git.
- Para inferencia: un GGUF compatible, llama.cpp con las capacidades que usa el launcher y hardware suficiente para el perfil elegido.
- Para compilación CUDA: toolchain C++ de Microsoft, CMake/Ninja, toolkit CUDA y driver compatibles con **tu** equipo.
- Para fallback/codegen: uv y Python 3.12.

Descarga las herramientas de sus proveedores oficiales y revisa sus licencias. No hay una GPU mínima certificada ni una promesa universal de memoria o rendimiento. No cambies drivers, firewall o configuración global sin una decisión explícita.

## 2. Código

```powershell
git clone https://github.com/Ghenwy/RolerIA-llm.git
Set-Location RolerIA-llm/DDRolLocal
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Dependencias incompletas' }
npm run check:source
if ($LASTEXITCODE -ne 0) { throw 'Comprobación de fuentes fallida' }
```

La ayuda CLI funciona sin modelo. El juego no: antes necesita el archivo local de configuración, modelo y runtime verificados.

## 3. Crear configuración exclusivamente local

Desde `DDRolLocal`:

```powershell
New-Item -ItemType Directory -Force config | Out-Null
if (Test-Path -LiteralPath config/runtime-profiles.json) {
    throw 'Ya existe configuración: conservarla y revisarla, no sobrescribir'
}
Copy-Item ../examples/runtime-profiles.example.json config/runtime-profiles.json
```

La plantilla usa valores **REPLACE_*** deliberadamente inválidos. Rellénalos con datos comprobados de tu instalación. No es nuestro perfil ni un archivo listo para usar.

Campos esenciales:

| Campo | Qué registrar localmente |
|---|---|
| `model.repository/revision/file` | Fuente del modelo, revisión inmutable y archivo elegido |
| `model.directory/alias` | Directorio sencillo bajo models y alias de servidor |
| `model.sha256` | Hash contrastado del GGUF descargado |
| `runtime.source_revision` | Commit upstream verificado de llama.cpp |
| `runtime.executable` | Ruta relativa segura bajo runtime |
| `runtime.sha256` | Hash del EXE compilado y revisado |
| `runtime.artifacts` | Nombres y hashes reales de todos sus DLL |
| Contexto, slots, KV y lotes | Perfil admitido por los contratos y validado en tu hardware |

Conserva los registros de procedencia y validación **localmente**. No subas `config/`, pesos, binarios, logs o campañas. No sustituyas hashes sólo para evitar un rechazo: compara bytes y revisa procedencia.

Descarga el modelo desde su proveedor oficial a `models/<directory>/<file>`, respetando su licencia. Verifica SHA-256 y crea `SHA256-local.txt` dentro de ese directorio **sólo después** de contrastar el archivo. Ni un sidecar ni un hash escrito a mano demuestran por sí solos procedencia.

## 4. Preparar llama.cpp

No se distribuye nuestro runtime ni ninguna release binaria. Obtén la fuente de [llama.cpp](https://github.com/ggml-org/llama.cpp), elige una revisión que soporte los flags del launcher y registra esa revisión localmente.

En un destino nuevo bajo `runtime/llama.cpp`, compila desde un entorno x64 de Build Tools. La forma general del configure es:

```text
cmake -S <fuente-verificada> -B <build-local> -G Ninja
  -DCMAKE_BUILD_TYPE=Release
  -DGGML_CUDA=ON
  -DGGML_CUDA_FA_ALL_QUANTS=ON
  -DCMAKE_CUDA_ARCHITECTURES=<arquitectura-de-tu-GPU>
  -DLLAMA_BUILD_SERVER=ON
cmake --build <build-local> --target llama-server
```

Son parámetros explicativos, no un script para pegar sin completar. Para caché Q5_1, comprueba que la revisión/build soporte la atención correspondiente. Revisa `llama-server --help` para los argumentos de `scripts/runtime/Start-NyxRuntime.ps1`, incluidos contexto por slot, KV, atención, lotes y loopback. No se asume que cualquier build upstream tenga los mismos flags.

Usa DLL procedentes del mismo build o toolkit verificado, nunca de sitios de descarga de DLL. Registra EXE/DLL y hashes reales en tu configuración local. Un build diferente no hereda pruebas del mantenedor. Si falta una capacidad, detén la instalación y explica la incompatibilidad; no desactives contratos ni verificaciones.

## 5. Preflight y juego

Desde `DDRolLocal`, una vez completada la configuración:

```powershell
pwsh -NoProfile -File scripts/runtime/Test-NyxRuntime.ps1 -Json -RequireReady
if ($LASTEXITCODE -ne 0) { throw 'Runtime no preparado: revisar checks fallidos' }
node dist/apps/tui/src/main.js runtime start
if ($LASTEXITCODE -ne 0) { throw 'Arranque fallido' }
node dist/apps/tui/src/main.js runtime status
node dist/apps/tui/src/main.js doctor
node dist/bootstrap/prepare-beta.js CAMPAIGN-alpha-01
if ($LASTEXITCODE -ne 0) { throw 'Campaña no preparada' }
node dist/apps/tui/src/main.js play CAMPAIGN-alpha-01
```

Health no demuestra inferencia: verifica una respuesta real. La preparación se ejecuta una vez por ID nuevo y nunca sobrescribe una campaña existente.

En la campaña inicial puedes conversar o seleccionar operaciones explícitas:

```text
Pregunto a Darío por la llave.
/rule movement.difficult_terrain ¿Cuánto cuesta avanzar?
/travel inn-to-bridge
/action rival-attack
/travel bridge-to-inn
```

El texto libre no cambia PG, inventario ni ubicación. Los efectos mecánicos pertenecen al código, no a la narración.

## 6. Guardar y detener

```powershell
node dist/apps/tui/src/main.js verify CAMPAIGN-alpha-01
node dist/apps/tui/src/main.js save CAMPAIGN-alpha-01
node dist/apps/tui/src/main.js runtime stop
```

Conserva la campaña completa y sus checkpoints. Si la compactación bloquea, no fuerces flags ni borres eventos/transcript.

## 7. Recuperación y desarrollo

Python conserva operaciones de recuperación y validación; no implementa toda la interacción Alpha. Para preparar sus dependencias sin sustituir el Python del sistema:

```powershell
uv python install 3.12
uv sync --locked --project fallback/python --python 3.12
```

Para cambios en contratos, usa los generadores incluidos. Las pruebas internas y resultados de investigación no se distribuyen y no son un requisito para compilar la fuente pública. `check:source` no certifica comportamiento, fidelidad narrativa o rendimiento.

Reporta sólo reproducciones mínimas ficticias. No adjuntes configuración real, información personal, campañas, prompts, hashes de inventario privado o logs crudos.
