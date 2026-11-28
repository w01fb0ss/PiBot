/** How long the fixed adapter waits for a person to answer the macOS calendar prompt. */
export const NATIVE_ACCESS_PROMPT_MS = 110_000;

export const CALENDAR_MAC_SCRIPT = `
ObjC.import('Foundation');
function plain(value) { return value == null || value.isNil && value.isNil() ? '' : ObjC.unwrap(value); }
function date(value) { var time = Date.parse(value); if (!isFinite(time)) throw Error('invalid_arguments'); return $.NSDate.dateWithTimeIntervalSince1970(time / 1000); }
function iso(value) { return new Date(Number(value.timeIntervalSince1970) * 1000).toISOString(); }
function waitAccess(request) { var done = false, granted = false; request(function(ok) { granted = Boolean(ok); done = true; }); var end = Date.now() + ${NATIVE_ACCESS_PROMPT_MS}; while (!done && Date.now() < end) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05)); if (!done || !granted) throw Error('permission_required'); }
function text(value, maximum) { if (typeof value !== 'string' || !value.length || value.length > maximum) throw Error('invalid_arguments'); return value; }
function number(value, fallback, maximum) { var n = value === undefined ? fallback : Number(value); if (!isFinite(n) || n < 0 || n % 1 || n > maximum) throw Error('invalid_arguments'); return n; }
function eventView(event) { return { id: plain(event.eventIdentifier), title: plain(event.title), start: iso(event.startDate), end: iso(event.endDate), calendarId: plain(event.calendar.calendarIdentifier), calendarName: plain(event.calendar.title), calendarWritable: Boolean(event.calendar.allowsContentModifications), location: plain(event.location), notes: plain(event.notes), allDay: Boolean(event.allDay) }; }
function calendarIds(args) {
  if (args.calendarIds !== undefined && args.calendarId !== undefined) throw Error('invalid_arguments');
  var ids = args.calendarIds !== undefined ? args.calendarIds : args.calendarId !== undefined ? [args.calendarId] : undefined;
  if (ids !== undefined && (!Array.isArray(ids) || !ids.length || ids.length > 100)) throw Error('invalid_arguments');
  if (ids) { ids.forEach(function(id) { text(id, 4096); }); if (new Set(ids).size !== ids.length) throw Error('invalid_arguments'); }
  return ids;
}
function calendar(req) {
  ObjC.import('EventKit');
  var store = $.EKEventStore.alloc.init, args = req.args;
  var status = Number($.EKEventStore.authorizationStatusForEntityType(0));
  if (status === 0) waitAccess(function(block) { if (store.respondsToSelector('requestFullAccessToEventsWithCompletion:')) store.requestFullAccessToEventsWithCompletion(block); else store.requestAccessToEntityTypeCompletion(0, block); });
  else if (status !== 3) throw Error('permission_required');
  if (req.tool === 'check') return { supported: true, driver: 'eventkit', readOnly: false };
  var calendars = store.calendarsForEntityType(0).js;
  if (req.tool === 'list_calendars') { if (calendars.length > 100) throw Error('read_failed'); return { items: calendars.map(function(item) { return { id: plain(item.calendarIdentifier), title: plain(item.title), writable: Boolean(item.allowsContentModifications) }; }) }; }
  if (req.tool === 'list_events') {
    stage = 'dates';
    var start = date(args.start), end = date(args.end);
    if (Number(end.timeIntervalSince1970) <= Number(start.timeIntervalSince1970) || Number(end.timeIntervalSince1970) - Number(start.timeIntervalSince1970) > 31 * 86400) throw Error('invalid_arguments');
    var ids = calendarIds(args);
    var selected = ids ? calendars.filter(function(item) { return ids.indexOf(plain(item.calendarIdentifier)) >= 0; }) : calendars;
    if (selected.length > 100) throw Error('read_failed');
    if (ids && selected.length !== ids.length) throw Error('not_found');
    var cursor = String(args.cursor).trim(), offset = /^[0-9]+$/.test(cursor) && Number(cursor) <= 100000 ? Number(cursor) : 0;
    var limit = number(args.limit, 50, 100);
    if (limit < 1) throw Error('invalid_arguments');
    if (!selected.length) return { items: [], nextCursor: null };
    stage = 'query';
    // Build a native array for multiple choices; a JS array is not an EventKit scope.
    var scope = $();
    if (ids) { scope = $.NSMutableArray.alloc.init; selected.forEach(function(item) { scope.addObject(item); }); }
    var events = store.eventsMatchingPredicate(store.predicateForEventsWithStartDateEndDateCalendars(start, end, scope)).js;
    if (events.length > 100000) throw Error('read_failed');
    stage = 'sort';
    events.sort(function(a,b) { return Number(a.startDate.timeIntervalSince1970) - Number(b.startDate.timeIntervalSince1970) || String(plain(a.calendar.calendarIdentifier)).localeCompare(String(plain(b.calendar.calendarIdentifier))) || String(plain(a.eventIdentifier)).localeCompare(String(plain(b.eventIdentifier))); });
    stage = 'view';
    return { items: events.slice(offset, offset + limit).map(eventView), nextCursor: offset + limit < events.length ? String(offset + limit) : null };
  }
  var event = req.tool === 'create_event' ? $.EKEvent.eventWithEventStore(store) : store.eventWithIdentifier(text(args.id, 4096));
  if (!event || event.isNil()) throw Error('not_found');
  // EventKit event updates with attendees could send invitations outside the explicit draft.
  if (req.tool !== 'create_event' && event.attendees && event.attendees.count > 0) throw Error('attendee_event_unsupported');
  if (req.tool === 'delete_event') { var de = Ref(); if (!store.removeEventSpanError(event, 0, de)) throw Error('write_failed'); return { deleted: true }; }
  if (req.tool === 'create_event') {
    var chosen = args.calendarId ? calendars.filter(function(item) { return plain(item.calendarIdentifier) === args.calendarId; })[0] : store.defaultCalendarForNewEvents;
    if (!chosen || chosen.isNil() || !chosen.allowsContentModifications) throw Error('calendar_read_only');
    event.calendar = chosen;
  }
  if (args.title !== undefined) event.title = text(args.title, 512);
  if (args.start !== undefined) event.startDate = date(args.start);
  if (args.end !== undefined) event.endDate = date(args.end);
  if (Number(event.endDate.timeIntervalSince1970) <= Number(event.startDate.timeIntervalSince1970)) throw Error('invalid_arguments');
  if (args.notes !== undefined) event.notes = text(args.notes, 8192);
  if (args.location !== undefined) event.location = text(args.location, 1024);
  if (args.allDay !== undefined) event.allDay = Boolean(args.allDay);
  var err = Ref(); if (!store.saveEventSpanError(event, 0, err)) throw Error('write_failed');
  return eventView(event);
}
// Which fixed step failed, so an unexpected error is diagnosable without exposing any data.
var stage = 'start';
function run() {
  try {
    var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var req = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)));
    return JSON.stringify({ ok: true, value: calendar(req) });
  } catch(error) {
    var allowed = ['permission_required','invalid_arguments','not_found','attendee_event_unsupported','calendar_read_only','write_failed','read_failed'];
    return JSON.stringify({ ok: false, code: allowed.indexOf(error.message) >= 0 ? error.message : 'native_app_failed', stage: stage + '_' + String(error && error.name || 'error').toLowerCase().replace(/[^a-z]/g, '').slice(0, 20) });
  }
}
`;
