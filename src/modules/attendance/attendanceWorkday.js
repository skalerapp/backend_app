const normalizeRole = (roleValue) => {
  const raw = (roleValue || '')
    .toString()
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s-]+/g, '_');

  switch (raw) {
    case 'admin':
    case 'super_admin':
    case 'superadmin':
      return 'super_admin';
    case 'administrativo':
    case 'administrative':
      return 'administrative';
    case 'manager':
    case 'coordinador':
    case 'coordinador_operaciones':
    case 'coordinator_operations':
      return 'coordinator_operations';
    case 'supervisor':
      return 'supervisor';
    case 'lider':
    case 'leader':
      return 'leader';
    case 'employee':
    case 'empleado':
    case 'colaborador':
      return 'employee';
    case 'operational_employee':
    case 'operational':
    case 'operativo':
    case 'empleado_operativo':
    case 'colaborador_operativo':
      return 'operational_employee';
    case 'warehouse_logistics':
    case 'commercial':
    case 'gerencial':
    case 'hse':
      return raw;
    default:
      return raw;
  }
};

const ATTENDANCE_EVENT_TYPES = Object.freeze([
  'operations_start',
  'lunch_start',
  'lunch_end',
  'operations_end',
]);

const WORKDAY_PROFILES = Object.freeze({
  FULL_OPERATIONS: 'full_operations',
  LUNCH_BREAK_ONLY: 'lunch_break_only',
  BASIC: 'basic',
});

const resolveWorkdayProfile = (roleValue) => {
  const role = normalizeRole(roleValue);
  if (['operational_employee', 'leader', 'supervisor', 'coordinator_operations'].includes(role)) {
    return WORKDAY_PROFILES.FULL_OPERATIONS;
  }
  if (['hse', 'administrative', 'warehouse_logistics', 'commercial'].includes(role)) {
    return WORKDAY_PROFILES.LUNCH_BREAK_ONLY;
  }
  return WORKDAY_PROFILES.BASIC;
};

const profileEventSequence = (profile) => {
  switch (profile) {
    case WORKDAY_PROFILES.FULL_OPERATIONS:
      return ['operations_start', 'lunch_start', 'lunch_end', 'operations_end'];
    case WORKDAY_PROFILES.LUNCH_BREAK_ONLY:
      return ['lunch_start', 'lunch_end'];
    default:
      return [];
  }
};

const eventLabelEs = (eventType) => {
  switch (eventType) {
    case 'operations_start':
      return 'Inicio de operaciones';
    case 'lunch_start':
      return 'Inicio de almuerzo';
    case 'lunch_end':
      return 'Fin de almuerzo';
    case 'operations_end':
      return 'Fin de operaciones';
    default:
      return eventType;
  }
};

const buildRecordedEventSet = (events = []) => {
  const recorded = new Set();
  for (const event of events) {
    const type = event?.event_type?.toString().trim();
    if (type) recorded.add(type);
  }
  return recorded;
};

const resolveWorkdayState = ({ roleValue, hasCheckIn, hasCheckOut, events = [] }) => {
  const profile = resolveWorkdayProfile(roleValue);
  const sequence = profileEventSequence(profile);
  const recorded = buildRecordedEventSet(events);

  if (!hasCheckIn) {
    return {
      profile,
      nextAction: 'check_in',
      nextActionLabel: 'Registrar entrada',
      bannerLabel: 'Sin registro hoy',
      statusMessage: 'Aún no hay entrada registrada para hoy.',
      canRegisterCheckIn: true,
      canRegisterCheckOut: false,
      canRegisterEvent: false,
      pendingEvents: sequence,
      completedEvents: [],
    };
  }

  if (hasCheckOut) {
    return {
      profile,
      nextAction: 'closed',
      nextActionLabel: 'Jornada cerrada',
      bannerLabel: 'Jornada cerrada',
      statusMessage: 'La jornada de hoy ya está cerrada.',
      canRegisterCheckIn: false,
      canRegisterCheckOut: false,
      canRegisterEvent: false,
      pendingEvents: [],
      completedEvents: sequence.filter((type) => recorded.has(type)),
    };
  }

  const nextEvent = sequence.find((type) => !recorded.has(type)) || null;
  if (nextEvent) {
    return {
      profile,
      nextAction: nextEvent,
      nextActionLabel: eventLabelEs(nextEvent),
      bannerLabel: 'Jornada en curso',
      statusMessage: `Siguiente paso: ${eventLabelEs(nextEvent).toLowerCase()}.`,
      canRegisterCheckIn: false,
      canRegisterCheckOut: false,
      canRegisterEvent: true,
      nextEventType: nextEvent,
      pendingEvents: sequence.filter((type) => !recorded.has(type)),
      completedEvents: sequence.filter((type) => recorded.has(type)),
    };
  }

  return {
    profile,
    nextAction: 'check_out',
    nextActionLabel: 'Registrar salida',
    bannerLabel: 'Entrada abierta',
    statusMessage: 'Todos los hitos están registrados. Falta cerrar la jornada con la salida.',
    canRegisterCheckIn: false,
    canRegisterCheckOut: true,
    canRegisterEvent: false,
    pendingEvents: [],
    completedEvents: sequence,
  };
};

const validateEventRegistration = ({ roleValue, events = [], eventType }) => {
  const normalizedType = eventType?.toString().trim();
  if (!ATTENDANCE_EVENT_TYPES.includes(normalizedType)) {
    return { ok: false, message: 'Tipo de evento no válido' };
  }

  const profile = resolveWorkdayProfile(roleValue);
  const sequence = profileEventSequence(profile);
  if (!sequence.includes(normalizedType)) {
    return { ok: false, message: 'Este perfil no utiliza ese hito de jornada' };
  }

  const recorded = buildRecordedEventSet(events);
  if (recorded.has(normalizedType)) {
    return { ok: false, message: `${eventLabelEs(normalizedType)} ya fue registrado hoy` };
  }

  const expectedNext = sequence.find((type) => !recorded.has(type));
  if (expectedNext !== normalizedType) {
    return {
      ok: false,
      message: `Debes registrar primero: ${eventLabelEs(expectedNext)}`,
    };
  }

  return { ok: true, eventType: normalizedType };
};

const validateCheckoutAllowed = ({ roleValue, events = [] }) => {
  const profile = resolveWorkdayProfile(roleValue);
  const sequence = profileEventSequence(profile);
  const recorded = buildRecordedEventSet(events);
  const missing = sequence.filter((type) => !recorded.has(type));
  if (missing.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    message: `Antes de registrar salida debes completar: ${missing.map(eventLabelEs).join(', ')}`,
  };
};

module.exports = {
  ATTENDANCE_EVENT_TYPES,
  WORKDAY_PROFILES,
  normalizeRole,
  resolveWorkdayProfile,
  profileEventSequence,
  eventLabelEs,
  resolveWorkdayState,
  validateEventRegistration,
  validateCheckoutAllowed,
};
