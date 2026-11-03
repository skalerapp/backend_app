const trimEnv = (key) => (process.env[key] || '').trim();

const envOrDefault = (key, fallback) => trimEnv(key) || fallback;

const CURRENT_TERMS_VERSION = envOrDefault('APP_TERMS_VERSION', '1.0');

const TERMS_TITLE = 'Términos y condiciones de uso — Skaler App';

/** Valores por defecto SKALER S.A.S. (fuente: skaler.com.co, RUES). Sobrescribibles por env. */
const SKALER_COMPANY_DEFAULTS = {
  legalName: 'SKALER S.A.S.',
  nit: '900.225.517-7',
  city: 'Cali, Valle del Cauca, Colombia',
  address: 'Calle 66 # 1N-66, Sector Industrial Calima, Cali',
  website: 'https://www.skaler.com.co',
  privacyEmail: 'comercialymarketing@skaler.com.co',
  phone: '(+57) 602 447 3636',
};

const isValidPublicHttpUrl = (value) => {
  if (!value) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
};

const getCompanyLegalContext = () => {
  const legalName = envOrDefault('APP_TERMS_COMPANY_LEGAL_NAME', SKALER_COMPANY_DEFAULTS.legalName);
  const nit = envOrDefault('APP_TERMS_COMPANY_NIT', SKALER_COMPANY_DEFAULTS.nit);
  const city = envOrDefault('APP_TERMS_COMPANY_CITY', SKALER_COMPANY_DEFAULTS.city);
  const address = envOrDefault('APP_TERMS_COMPANY_ADDRESS', SKALER_COMPANY_DEFAULTS.address);
  const website = envOrDefault('APP_TERMS_COMPANY_WEBSITE', SKALER_COMPANY_DEFAULTS.website);
  const privacyEmail = envOrDefault(
    'APP_TERMS_PRIVACY_CONTACT_EMAIL',
    SKALER_COMPANY_DEFAULTS.privacyEmail,
  );
  const phone = envOrDefault('APP_TERMS_COMPANY_PHONE', SKALER_COMPANY_DEFAULTS.phone);

  const identityLine = `${legalName} — NIT ${nit} — ${city}`;

  const contactLine =
    `Para ejercer derechos sobre datos personales o consultas de privacidad: ${privacyEmail}` +
    (phone ? ` · Tel. ${phone}` : '') +
    `. Sitio web: ${website}.`;

  return {
    legalName,
    nit,
    city,
    address,
    website,
    privacyEmail,
    phone,
    identityLine,
    contactLine,
  };
};

const buildTermsSections = () => {
  const { identityLine, contactLine, legalName, address } = getCompanyLegalContext();

  return [
    {
      id: 'controller',
      title: '1. Responsable y objeto',
      body:
        `Skaler App es una plataforma corporativa operada por ${legalName} (en adelante, «Skaler App» o «la Empresa»), identificada con ${identityLine}. Domicilio principal: ${address}. ` +
        'La plataforma apoya la gestión de obra, personal, logística, comercial, HSE y procesos internos. Al iniciar sesión, usted declara haber leído y aceptado estos términos y autoriza el tratamiento de datos descrito aquí, en el marco de su relación laboral o contractual con la Empresa y de la normativa colombiana aplicable (incluida la Ley 1581 de 2012 y normas complementarias sobre protección de datos personales).',
    },
    {
      id: 'authorized_use',
      title: '2. Uso autorizado y dispositivos',
      body:
        'El acceso es personal, intransferible y solo para fines laborales autorizados. Puede usar la aplicación móvil Skaler App (Android) o el acceso web en navegador (por ejemplo en iPhone/iPad). Si utiliza un dispositivo personal, lo hace bajo su responsabilidad: debe mantener bloqueo de pantalla, sistema actualizado, antivirus razonable y no compartir credenciales. La Empresa puede suspender cuentas por uso indebido, fraude o incumplimiento de políticas internas.',
    },
    {
      id: 'account',
      title: '3. Cuenta, credenciales y sesión',
      body:
        'Usted es responsable de la confidencialidad de su usuario y contraseña y de toda actividad registrada con su cuenta. En la web, la sesión puede cerrarse por tiempo de uso o inactividad. Tras varios intentos fallidos de ingreso, el acceso puede bloquearse temporalmente por seguridad. No intente eludir controles de autenticación ni acceder a información de terceros sin autorización.',
    },
    {
      id: 'device_permissions',
      title: '4. Permisos y funciones en su dispositivo',
      body:
        'Para operar, Skaler App puede solicitar y utilizar las siguientes capacidades, según el módulo y su rol:\n\n' +
        '• Red e internet: enviar y recibir datos con los servidores de la Empresa (sincronización, login, reportes).\n' +
        '• Ubicación (GPS): registrar georreferencia en procesos como asistencia o controles en sitio, cuando la función esté activa.\n' +
        '• Cámara y galería: capturar o adjuntar evidencias fotográficas (asistencia, obra, HSE, logística, etc.).\n' +
        '• Notificaciones: avisos operativos y recordatorios cuando estén habilitados.\n' +
        '• Almacenamiento local y caché: guardar temporalmente sesión, preferencias, cola de sincronización y datos de consulta para continuidad operativa y modo sin conexión en la app móvil (la web puede tener capacidades limitadas sin conexión).\n' +
        '• Identificadores técnicos: tipo de dispositivo, sistema operativo, versión de la app, dirección IP y agente de navegador, para seguridad, auditoría y soporte.\n\n' +
        'Puede denegar permisos en el sistema operativo; algunas funciones dejarán de estar disponibles si son necesarias para ese proceso.',
    },
    {
      id: 'personal_data',
      title: '5. Datos personales y finalidades',
      body:
        'La Empresa trata datos asociados a su usuario y, cuando exista, a su ficha de colaborador (por ejemplo: nombre, identificación, correo, cargo, área, registros de asistencia, ubicación cuando aplique, evidencias, formularios operativos, observaciones de supervisión y trazabilidad de acciones en la plataforma). Las finalidades incluyen: operación y control de obra, nómina y asistencia, seguridad y salud en el trabajo, logística, cumplimiento legal, auditoría interna y defensa de derechos en procesos administrativos o judiciales. El tratamiento se realiza con medidas de seguridad razonables; los datos se alojan en infraestructura contratada por la Empresa (servicios en la nube) con acceso restringido por rol.',
    },
    {
      id: 'rights',
      title: '6. Sus derechos',
      body:
        `Como titular de datos personales, puede conocer, actualizar, rectificar y suprimir información, y revocar la autorización cuando proceda, conforme a la Ley 1581 de 2012 y la política de tratamiento de datos de la Empresa. ${contactLine} La revocación puede implicar que no sea posible continuar usando funciones que dependan de ese tratamiento.`,
    },
    {
      id: 'monitoring',
      title: '7. Trazabilidad, auditoría y comunicaciones',
      body:
        'Los registros generados en Skaler App (fecha, hora, usuario, acciones relevantes, evidencias y, cuando aplique, ubicación) pueden ser consultados por personal autorizado de la Empresa para control operativo, investigación de incidentes y cumplimiento normativo. La aceptación de estos términos queda registrada en el sistema con versión del documento, fecha, datos de usuario y referencias técnicas de acceso.',
    },
    {
      id: 'confidentiality',
      title: '8. Confidencialidad y propiedad',
      body:
        'La información operativa, comercial y de clientes visible en Skaler App es confidencial de la Empresa. Queda prohibido copiar, divulgar o usar esa información fuera de sus funciones autorizadas, salvo obligación legal o instrucción expresa de la Empresa.',
    },
    {
      id: 'acceptance',
      title: '9. Aceptación y cambios',
      body:
        'La aceptación se solicita una vez por cada versión publicada de estos términos. Si se publica una nueva versión, deberá aceptarla en el siguiente inicio de sesión para continuar. La Empresa puede actualizar la plataforma y este texto para reflejar nuevas funciones o requisitos legales; la versión vigente es la indicada al momento del login.',
    },
  ];
};

const getTermsDocumentUrl = () => {
  const raw = trimEnv('APP_TERMS_DOCUMENT_URL');
  if (isValidPublicHttpUrl(raw)) return raw;

  const webBase = envOrDefault(
    'WEB_APP_URL',
    envOrDefault('FRONTEND_URL', 'https://skalerapp-web.web.app'),
  );
  return `${webBase.replace(/\/+$/, '')}/terms/terminos-skaler-app-v1.html`;
};

const getCurrentTermsPayload = () => {
  const ctx = getCompanyLegalContext();
  return {
    version: CURRENT_TERMS_VERSION,
    title: TERMS_TITLE,
    sections: buildTermsSections(),
    effectiveLabel: `Versión ${CURRENT_TERMS_VERSION} — Skaler App · ${ctx.legalName} · NIT ${ctx.nit}`,
    documentUrl: getTermsDocumentUrl(),
    company: {
      legalName: ctx.legalName,
      nit: ctx.nit,
      city: ctx.city,
      address: ctx.address,
      website: ctx.website,
      privacyEmail: ctx.privacyEmail,
      phone: ctx.phone,
    },
  };
};

module.exports = {
  CURRENT_TERMS_VERSION,
  TERMS_TITLE,
  SKALER_COMPANY_DEFAULTS,
  buildTermsSections,
  getCompanyLegalContext,
  getTermsDocumentUrl,
  getCurrentTermsPayload,
  isValidPublicHttpUrl,
};
