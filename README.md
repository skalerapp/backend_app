# SKALER Backend

API REST del sistema SKALER (gestión operativa, comercial, viáticos, materiales, almacén y auditoría).

## Requisitos

- Node.js 18+
- MySQL 8+
- npm

## Inicio rápido

### 1. Instalar dependencias

```bash
npm install
```

### 2. Configurar `.env`

Copia `.env.example` a `.env` y ajusta credenciales:

```env
PORT=3000
NODE_ENV=development
API_URL=http://localhost:3000

DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=skaler_db

JWT_SECRET=your_super_secret_jwt_key_here_change_in_production
JWT_EXPIRE=24h

UPLOAD_DIR=./uploads
MAX_FILE_SIZE=10485760

FRONTEND_URL=http://localhost:8080
DASHBOARD_URL=http://localhost:3001
WEB_APP_URL=http://localhost:8080
WEB_LAUNCH_TICKET_EXPIRE=30m
WEB_SESSION_EXPIRE=12h
APP_SESSION_HEARTBEAT_TTL=90s
```

> **Producción (Railway):** el disco del contenedor es efímero. Monta un [Railway Volume](https://docs.railway.com/guides/volumes) en `/data/uploads` y define `UPLOAD_DIR=/data/uploads`. Ver `documentation/DEPLOYMENT_CLIENT_RAILWAY.md` → *Paso 5*.

### 3. Crear / sincronizar base de datos

**Opción recomendada (local):** reconstruye la BD desde `database/schema.sql`, aplica el schema actual de todos los módulos e instala triggers de auditoría.

```bash
# BD limpia + admin + usuario comercial por defecto
npm run db:rebuild:local

# BD limpia + solo admin@skaler.com (ideal para pruebas)
npm run db:reset:admin-only
```

Credenciales por defecto tras el rebuild:

| Usuario | Email | Contraseña |
|---------|-------|------------|
| Admin | `admin@skaler.com` | `admin123` |
| Comercial *(solo `db:rebuild:local`)* | `commercial@skaler.com` | `commercial123` |

El reset también reinicia consecutivos (`counters.quotation = 0`).

**Opción manual (solo schema base):**

```bash
mysql -u root -p < ../database/schema.sql
npm run db:schema:sync
```

`db:schema:sync` crea/actualiza tablas de viáticos, comercial, almacén, alcances operativos y auditoría sin borrar datos existentes.

### 4. Ejecutar servidor

```bash
# Desarrollo (auto-reload)
npm run dev

# Producción
npm start
```

Healthcheck:

```text
GET http://localhost:3000/api/health
=> {"success":true,"message":"Backend funcionando"}
```

## Scripts npm

| Script | Descripción |
|--------|-------------|
| `npm run dev` | Servidor con nodemon |
| `npm start` | Servidor en producción |
| `npm test` | Tests Jest (ejecuta en serie) |
| `npm run db:rebuild:local` | Drop + recreate BD, schema sync, admin + comercial |
| `npm run db:reset:admin-only` | Igual que rebuild, pero **solo** `admin@skaler.com` |
| `npm run db:schema:sync` | Sincroniza tablas/columnas **sin borrar datos** (usar en prod cliente) |
| `npm run db:schema:export` | Exporta schema actual a `database/schema.sql` |
| `npm run db:schema:export` | Exporta schema actual a SQL |
| `npm run db:seed:demo` | Carga datos demo operativos |
| `npm run cleanup:test-data` | Elimina usuarios/proyectos de prueba detectados por patrón |
| `npm run cleanup:test-data -- --apply` | Aplica la limpieza |
| `npm run reset:auto-increment` | Preview de AUTO_INCREMENT por tabla |
| `npm run reset:auto-increment -- --apply` | Ajusta AUTO_INCREMENT según MAX(id) |
| `npm run migrate:audit:triggers` | Instala triggers de auditoría |
| `npm run verify:audit:triggers` | Verifica triggers instalados |
| `npm run migrate:users:roles:v1` | Normaliza roles legacy en `users.role` |
| `npm run migrate:users:super-admin` | Promueve usuario admin a `super_admin` |
| `npm run assign:users:role` | Asigna rol a usuarios por email |
| `npm run import:warehouse:assets` | Importa activos de almacén desde CSV |

### Limpieza de datos de prueba

- **`db:reset:admin-only`**: borra **toda** la base y deja solo el admin. Usar cuando quieras empezar de cero.
- **`cleanup:test-data`**: borra selectivamente registros que coinciden con patrones de test (RBAC, demo, prueba). No toca `admin@skaler.com`.

## Módulos y rutas API

| Prefijo | Módulo |
|---------|--------|
| `/api/auth` | Autenticación, sesiones web |
| `/api/users` | Usuarios y roles |
| `/api/employees` | Empleados |
| `/api/projects` | Proyectos |
| `/api/activities` | Actividades |
| `/api/attendance` | Asistencia |
| `/api/labor-permissions` | Permisos laborales |
| `/api/allowances` | Viáticos, solicitudes y gastos |
| `/api/materials` | Materiales por proyecto |
| `/api/warehouse` | Almacén / activos |
| `/api/operational-scopes` | Alcances operativos por rol |
| `/api/commercial` | Comercial V2 (clientes, visitas, embudo, cotizaciones) |
| `/api/app` | Versión mínima/requerida de la app móvil (`GET /version`, público) |
| `/api/evidence` | Carga de evidencias |
| `/api/audit-logs` | Auditoría |

### Comercial — reglas clave

- **Cliente comercial** = sede identificada por **NIT + ciudad** (mismo NIT puede repetirse en otra ciudad).
- **Clientes**: `GET/POST /api/commercial/clients`, `PUT /api/commercial/clients/:id`, búsqueda con `?q=`.
- **Cotizaciones**: consecutivo en tabla `counters` (`quotation`).
- Permisos por rol en `src/config/moduleAccessPolicy.js`.

### Versión de app móvil

Endpoint público `GET /api/app/version`. Variables en Railway (plantilla: `.env.client.railway.example`):

- `APP_VERSION_CHECK_ENABLED`, `APP_LATEST_*`, `APP_MIN_*`
- `APP_ANDROID_DOWNLOAD_URL`, `APP_GITHUB_RELEASES_URL`

Releases APK: repo `skalerapp/skaler-app-updates` — ver `documentation/APP_RELEASES_GITHUB.md`.

### Almacén — migración MySQL

`ensureWarehouseShape` usa `information_schema` para agregar columnas (MySQL 8 no soporta `ADD COLUMN IF NOT EXISTS`). Si ves error 500 en `/api/warehouse/assets`, despliega la versión actual de `warehouse.service.js`.

## Estructura del proyecto

```
backend/
├── src/
│   ├── server.js              # Entrada Express + CORS + rutas
│   ├── config/
│   │   ├── database.js        # Pool MySQL
│   │   └── moduleAccessPolicy.js
│   ├── middleware/
│   │   └── auth.middleware.js
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── employees/
│   │   ├── projects/
│   │   ├── activities/
│   │   ├── attendance/
│   │   ├── laborPermissions/
│   │   ├── allowances/
│   │   ├── materials/
│   │   ├── warehouse/
│   │   ├── operationalScopes/
│   │   ├── commercial/
│   │   ├── evidence/
│   │   └── audit/
│   └── utils/                 # Migraciones, seeds, rebuild BD
├── test/                      # Tests Jest + Supertest
├── migrations/                # SQL sueltos (comercial, counters)
├── uploads/                   # Archivos subidos
├── package.json
├── .env.example
└── README.md
```

Cada módulo suele tener `*.routes.js` + `*.controller.js`. El schema evolutivo vive en funciones `ensure*Schema` de cada controlador y se centraliza en `syncCurrentSchema.js`.

## Testing

```bash
# Todos los tests
npm test

# Un archivo
npm test -- test/commercial.test.js

# Cobertura
npm test -- --coverage
```

Los tests asumen `admin@skaler.com` / `admin123` y base de datos de prueba configurada en el entorno de Jest.

## Despliegue en Railway

Repositorio GitHub: **`Jhonatan-soto/backend_skaler`** (el backend está en la **raíz** del repo, no en una carpeta `backend/`).

### 1. Root Directory (causa habitual del error `Cannot find module /app/src/server.js`)

En Railway → servicio **backend_app** → **Settings** → **Root Directory**:

| Tipo de repo | Root Directory |
|--------------|----------------|
| Repo solo-backend (`backend_skaler`) | **vacío** o `/` |
| Monorepo Skaler completo | `backend` |

Si pones `backend` en un repo que ya es solo-backend, Railway busca `/app/backend/src/server.js` y el deploy falla en el healthcheck.

### 2. Variables de entorno (servicio backend)

En **Variables**, vincula el servicio MySQL **o** pega:

```env
NODE_ENV=production
PORT=3000
API_URL=https://TU-DOMINIO-PUBLICO.up.railway.app
JWT_SECRET=<secreto-largo-unico>
DB_SSL=true
DATABASE_URL=mysql://root:PASSWORD@HOST:PUERTO/railway
```

Genera `JWT_SECRET` (PowerShell):

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
```

Referencia: `.env.client.railway.example`

### 3. Dominio público

Railway → **backend_app** → **Settings** → **Networking** → **Generate Domain**.  
Copia esa URL (ej. `https://backend-app-production-xxxx.up.railway.app`) y úsala en `API_URL` y en la app Flutter.

### 4. Sincronizar schema en MySQL Railway (una vez)

Desde tu PC (no commitees el `.env` con la URL):

```powershell
cd backend
# Crea .env.client.sync con DATABASE_URL=... (ver .env.client.sync.example)
.\scripts\sync-schema-production.ps1 -EnvFile .env.client.sync -SkipBackupReminder
```

### 5. Verificar

```powershell
Invoke-RestMethod https://TU-DOMINIO.up.railway.app/api/health
```

### 6. App Flutter apuntando a Railway

Debug:

```powershell
cd frontend\flutter
flutter run --dart-define=API_BASE_URL=https://TU-DOMINIO.up.railway.app/api
```

APK release:

```powershell
.\scripts\build_client_release.ps1 -ApiBaseUrl "https://TU-DOMINIO.up.railway.app/api"
```

**No usar** `db:reset:admin-only` en producción — borra usuarios.

## Formato de respuestas

**Éxito**

```json
{
  "success": true,
  "message": "Operación exitosa",
  "data": {}
}
```

**Error**

```json
{
  "success": false,
  "message": "Descripción del error",
  "error": "Detalle técnico (solo en development)"
}
```

## Seguridad

- Contraseñas con bcrypt
- JWT stateless
- CORS configurable (`CORS_ORIGINS`, `FRONTEND_URL`, `WEB_APP_URL`)
- Validación en rutas sensibles
- Auditoría vía triggers MySQL (`audit_logs`)

## Migraciones puntuales

```bash
# Eliminar columna legacy attendance.status
npm run migrate:attendance:drop-status

# Backfill columnas legacy en activities
npm run migrate:activities:backfill-legacy

# Roles legacy → taxonomía V1 (simulación)
npm run migrate:users:roles:v1
npm run migrate:users:roles:v1 -- --apply
```

## Dependencias principales

| Paquete | Uso |
|---------|-----|
| express | API HTTP |
| mysql2 | MySQL |
| jsonwebtoken | Auth JWT |
| bcryptjs | Hash contraseñas |
| multer | Uploads |
| express-validator | Validación |
| cors / morgan / dotenv | Infra |

---

**Última actualización:** Junio 2026  
**Equipo:** JMS Tech
