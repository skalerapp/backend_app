# SKALER Backend - Configuración de Desarrollo

## Instalación paso a paso

### 1. Instalar dependencias
```bash
npm install
```

### 2. Configurar ambiente
Crear archivo `.env` en la raíz del backend:

```env
# Servidor
PORT=3000
NODE_ENV=development
API_URL=http://localhost:3000

# Base de Datos
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=skaler_db

# JWT
JWT_SECRET=your_super_secret_jwt_key_here_change_in_production
JWT_EXPIRE=24h

# Almacenamiento
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=10485760

# Aplicaciones
FRONTEND_URL=http://localhost:8080
DASHBOARD_URL=http://localhost:3001
WEB_APP_URL=http://localhost:8080
WEB_LAUNCH_TICKET_EXPIRE=30m
WEB_SESSION_EXPIRE=12h
APP_SESSION_HEARTBEAT_TTL=90s
```

### 2.1. Configuración en Railway

Si vas a desplegar el backend en Railway, usa como referencia el archivo `.env.railway.example`.

Variables mínimas recomendadas en Railway:

```env
NODE_ENV=production
PORT=3000
API_URL=https://TU-BACKEND.railway.app
DATABASE_URL=mysql://root:TU_PASSWORD@HOST:PUERTO/railway
JWT_SECRET=un_secreto_largo_y_unico
FRONTEND_URL=https://TU-FRONTEND.web.app
WEB_APP_URL=https://TU-FRONTEND.web.app
CORS_ORIGINS=https://TU-FRONTEND.web.app
DB_SSL=true
```

Notas:
- Si Railway ya inyecta `MYSQLHOST`, `MYSQLPORT`, `MYSQLUSER`, `MYSQLPASSWORD` y `MYSQLDATABASE`, no necesitas definir `DATABASE_URL`.
- `CORS_ORIGINS` puede llevar varias URLs separadas por coma.
- `WEB_APP_URL` es la URL pública que abrirá el acceso web temporal generado desde la app.

### 3. Crear base de datos
```bash
mysql -u root -p < ../database/schema.sql
```

En Railway, la base de datos ya puede cargarse importando `../database/schema.sql` contra la instancia MySQL remota.

### 4. Ejecutar servidor
```bash
# Desarrollo (con auto-reload)
npm run dev

# Producción
npm start
```

### 5. Despliegue externo con Railway

Orden recomendado:

1. Crear el servicio backend en Railway apuntando a la carpeta `backend/`.
2. Cargar las variables de entorno de producción.
3. Verificar que Railway detecte el comando `npm start`.
4. Confirmar que el healthcheck responda en `/api/health`.
5. Probar login desde la app Flutter usando la URL pública del backend.

Importante:
- Si el proyecto se despliega desde la raíz del repositorio, en Railway debes definir `Root Directory = backend`.
- Si no configuras esa carpeta raíz, Railway intentará arrancar desde la raíz del proyecto y fallará porque ahí no existe `package.json` del backend.

Ejemplo de healthcheck esperado:

```text
GET https://TU-BACKEND.railway.app/api/health
=> {"success":true,"message":"Backend funcionando"}
```

## Estructura de directorios

```
backend/
├── src/
│   ├── modules/           # Módulos funcionales
│   │   ├── auth/
│   │   │   ├── auth.routes.js
│   │   │   └── auth.controller.js
│   │   ├── admin/
│   │   ├── projects/
│   │   ├── operative/
│   │   ├── warehouse/
│   │   ├── commercial/
│   │   ├── hse/
│   │   └── dashboard/
│   ├── middleware/        # Middlewares globales
│   │   └── auth.middleware.js
│   ├── utils/            # Funciones auxiliares
│   │   └── auth.utils.js
│   ├── config/           # Configuración
│   │   └── database.js
│   └── server.js         # Servidor principal
├── uploads/              # Archivos subidos
├── package.json
├── .env                  # Variables de entorno (NO INCLUIR EN GIT)
├── .env.example         # Plantilla de .env
└── README.md
```

## Desarrollo de nuevos módulos

Cada módulo debe tener:
- `MODULE.routes.js` - Definición de rutas
- `MODULE.controller.js` - Lógica de negocio
- `MODULE.model.js` (opcional) - Consultas a BD

### Ejemplo de módulo

1. Crear archivos:
```bash
mkdir -p src/modules/nuevo_modulo
touch src/modules/nuevo_modulo/{nuevo_modulo.routes.js,nuevo_modulo.controller.js}
```

2. Implementar routes:
```javascript
const express = require('express');
const router = express.Router();
const controller = require('./nuevo_modulo.controller');
const { verifyToken } = require('../../middleware/auth.middleware');

router.get('/', verifyToken, controller.getAll);
router.post('/', verifyToken, controller.create);
router.put('/:id', verifyToken, controller.update);
router.delete('/:id', verifyToken, controller.delete);

module.exports = router;
```

3. Registrar en server.js:
```javascript
const nuevoModuloRoutes = require('./modules/nuevo_modulo/nuevo_modulo.routes');
app.use('/api/nuevo-modulo', nuevoModuloRoutes);
```

## Testing

```bash
# Ejecutar todos los tests
npm test

# Tests con cobertura
npm test -- --coverage

# Tests en modo observación
npm test -- --watch
```

## Migración opcional (asistencia)

Si deseas eliminar definitivamente la columna `status` de `attendance` (flujo basado solo en entrada/salida):

```bash
npm run migrate:attendance:drop-status
```

## Reparación histórica (actividades)

Si deseas completar columnas legacy de `activities` (`title`, `date`, `activity_date`, `start_time`, `end_time`, `hours_worked`, `evidences`) para registros antiguos:

```bash
npm run migrate:activities:backfill-legacy
```

## Migración V1 de roles de usuarios

Estandariza valores legacy en `users.role` (por ejemplo `admin`, `manager`, `lider`, `empleado`) hacia la taxonomía oficial:

- `administrative`
- `coordinator_operations`
- `supervisor`
- `leader`
- `employee`
- `gerencial`

Primero ejecuta en modo simulación (sin cambios):

```bash
npm run migrate:users:roles:v1
```

Para aplicar cambios reales:

```bash
npm run migrate:users:roles:v1 -- --apply
```

Notas:
- El script es idempotente.
- Los roles no reconocidos como oficiales quedan sin cambio y se listan para revisión manual.

## Dependencias principales

| Paquete | Versión | Uso |
|---------|---------|-----|
| express | ^4.18 | Framework web |
| cors | ^2.8 | CORS |
| dotenv | ^16.0 | Variables de entorno |
| bcryptjs | ^2.4 | Hash de contraseñas |
| jsonwebtoken | ^9.0 | JWT |
| mysql2 | ^3.2 | Driver MySQL |
| multer | ^1.4 | Subida de archivos |
| morgan | ^1.10 | Logging HTTP |

## API Response Format

Todas las respuestas seguirán este formato:

**Éxito (200, 201)**
```json
{
  "success": true,
  "message": "Operación exitosa",
  "data": { /* datos */ }
}
```

**Error (400, 401, 403, 500)**
```json
{
  "success": false,
  "message": "Descripción del error",
  "error": "Detalles técnicos (solo en desarrollo)"
}
```

## Códigos HTTP

| Código | Significado |
|--------|------------|
| 200 | OK - Operación exitosa |
| 201 | Created - Recurso creado |
| 400 | Bad Request - Datos inválidos |
| 401 | Unauthorized - No autenticado |
| 403 | Forbidden - No autorizado |
| 404 | Not Found - Recurso no existe |
| 500 | Server Error - Error interno |

## Seguridad

- ✅ Todas las contraseñas hasheadas con bcrypt
- ✅ JWT para autenticación stateless
- ✅ CORS configurado
- ✅ Validación de entrada en todos los endpoints
- ✅ Rate limiting (implementar si es necesario)

## Debugging

Habilitar logs detallados:
```bash
DEBUG=skaler:* npm run dev
```

## Deployment

### En producción

1. Cambiar `.env`:
```env
NODE_ENV=production
JWT_SECRET=STRONG_SECRET_HERE
DB_PASSWORD=SECURE_PASSWORD
```

2. Instalar dependencias de producción:
```bash
npm install --production
```

3. Iniciar con PM2:
```bash
npm install -g pm2
pm2 start src/server.js --name "skaler-api"
pm2 startup
pm2 save
```

## Monitoreo

Se recomienda usar:
- **PM2** para gestión de procesos
- **Sentry** para tracking de errores
- **DataDog** o **New Relic** para monitoreo

## Recursos útiles

- [Express.js Documentation](https://expressjs.com)
- [MySQL2 Docs](https://github.com/sidorares/node-mysql2)
- [JWT Best Practices](https://tools.ietf.org/html/rfc7519)
- [OWASP API Security](https://owasp.org/www-project-api-security/)

---

**Última actualización**: Marzo 2026  
**Equipo**: JMS Tech
