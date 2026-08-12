const SESSION_TICKET_PATTERN = /^[A-Z][A-Z0-9]{0,9}-[1-9][0-9]{0,8}$/;

export function normalizeSessionTicket(value) {
  if (value == null) return null;

  const ticket = String(value).trim().toUpperCase();
  return SESSION_TICKET_PATTERN.test(ticket) ? ticket : null;
}
