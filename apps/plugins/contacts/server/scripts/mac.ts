/** How long the fixed adapter waits for a person to answer the macOS contacts prompt. */
export const NATIVE_ACCESS_PROMPT_MS = 110_000;

export const CONTACTS_MAC_SCRIPT = `
ObjC.import('Foundation');
function plain(value) { return value == null || value.isNil && value.isNil() ? '' : ObjC.unwrap(value); }
function waitAccess(request) { var done = false, granted = false; request(function(ok) { granted = Boolean(ok); done = true; }); var end = Date.now() + ${NATIVE_ACCESS_PROMPT_MS}; while (!done && Date.now() < end) $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05)); if (!done || !granted) throw Error('permission_required'); }
function text(value, maximum) { if (typeof value !== 'string' || !value.length || value.length > maximum) throw Error('invalid_arguments'); return value; }
function number(value, fallback, maximum) { var n = value === undefined ? fallback : Number(value); if (!isFinite(n) || n < 0 || n % 1 || n > maximum) throw Error('invalid_arguments'); return n; }
function contacts(req) {
  ObjC.import('Contacts');
  var store = $.CNContactStore.alloc.init, args = req.args;
  var status = Number($.CNContactStore.authorizationStatusForEntityType(0));
  diagnostics.status = status;
  if (status === 0) {
    try { waitAccess(function(block) { store.requestAccessForEntityTypeCompletionHandler(0, block); }); }
    finally { status = Number($.CNContactStore.authorizationStatusForEntityType(0)); diagnostics.status = status; }
  }
  if (status !== 3 && status !== 4) throw Error('permission_required');
  if (req.tool === 'check') return { supported: true, driver: 'contacts', readOnly: false };
  var countOnly = req.tool === 'count_contacts';
  var listOnly = req.tool === 'list_contacts' || countOnly;
  var keys = countOnly ? $([$.CNContactIdentifierKey]) : $([$.CNContactIdentifierKey, $.CNContactGivenNameKey, $.CNContactFamilyNameKey, $.CNContactOrganizationNameKey].concat(listOnly ? [] : [$.CNContactEmailAddressesKey, $.CNContactPhoneNumbersKey]));
  function view(contact) { var value = { id: plain(contact.identifier), givenName: plain(contact.givenName), familyName: plain(contact.familyName), organization: plain(contact.organizationName) }; if (!listOnly) { value.emails = contact.emailAddresses.js.map(function(item) { return plain(item.value); }); value.phones = contact.phoneNumbers.js.map(function(item) { return plain(item.value.stringValue); }); } return value; }
  if (req.tool === 'search_contacts' || listOnly) {
    var containerError = Ref(), containers = store.containersMatchingPredicateError(null, containerError);
    if (!containers || containers.isNil && containers.isNil() || containerError[0] && !(containerError[0].isNil && containerError[0].isNil())) throw Error('read_failed');
    var containerCount = Number(containers.count);
    if (!isFinite(containerCount) || containerCount < 0 || containerCount % 1) throw Error('read_failed');
    diagnostics.containerCount = containerCount;
    // Sandboxed, the account list can come back empty while enumeration still returns every
    // contact, so only an empty account list with nothing enumerated means unavailable.
    var fetch = $.CNContactFetchRequest.alloc.initWithKeysToFetch(keys);
    var query = listOnly ? '' : text(args.query, 256).toLocaleLowerCase();
    var digits = /^[+0-9 .()-]+$/.test(query) ? query.replace(/[^0-9]/g, '') : '';
    function matches(value) { return listOnly || [value.givenName + ' ' + value.familyName, value.familyName + value.givenName, value.organization].concat(value.emails).some(function(part) { return part.toLocaleLowerCase().indexOf(query) >= 0; }) || (digits.length > 0 && value.phones.some(function(phone) { return phone.replace(/[^0-9]/g, '').indexOf(digits) >= 0; })); }
    fetch.sortOrder = 1;
    var cursor = String(args.cursor).trim(), offset = /^[0-9]+$/.test(cursor) && Number(cursor) <= 100000 ? Number(cursor) : 0;
    var limit = number(args.limit, 50, 100), index = 0, scanned = 0, items = [], more = false, scanLimit = false, err = Ref();
    if (limit < 1) throw Error('invalid_arguments');
    var ok = store.enumerateContactsWithFetchRequestErrorUsingBlock(fetch, err, function(contact, stop) { if (++scanned > 10000) { scanLimit = true; stop[0] = true; return; } if (countOnly) return; var value = view(contact); if (!matches(value)) return; if (index++ < offset) return; if (items.length >= limit) { more = true; stop[0] = true; return; } items.push(value); });
    if (!ok) throw Error('read_failed');
    if (scanLimit) throw Error('contact_scan_limit');
    if (scanned === 0 && containerCount === 0) throw Error('contacts_unavailable');
    if (countOnly) return { total: scanned };
    return { items: items, nextCursor: more ? String(offset + items.length) : null };
  }
  var contact;
  if (req.tool === 'create_contact') contact = $.CNMutableContact.alloc.init;
  else { var error = Ref(), old = store.unifiedContactWithIdentifierKeysToFetchError(text(args.id, 4096), keys, error); if (!old || old.isNil()) throw Error('not_found'); contact = old.mutableCopy; }
  var request = $.CNSaveRequest.alloc.init;
  if (req.tool === 'delete_contact') request.deleteContact(contact);
  else {
    if (args.givenName !== undefined) contact.givenName = text(args.givenName, 256);
    if (args.familyName !== undefined) contact.familyName = text(args.familyName, 256);
    if (args.organization !== undefined) contact.organizationName = text(args.organization, 512);
    if (args.email !== undefined) contact.emailAddresses = $([$.CNLabeledValue.labeledValueWithLabelValue($.CNLabelHome, $(text(args.email, 512)))]);
    if (args.phone !== undefined) contact.phoneNumbers = $([$.CNLabeledValue.labeledValueWithLabelValue($.CNLabelPhoneNumberMobile, $.CNPhoneNumber.phoneNumberWithStringValue(text(args.phone, 128)))]);
    if (req.tool === 'create_contact') request.addContactToContainerWithIdentifier(contact, null); else request.updateContact(contact);
  }
  var err = Ref(); if (!store.executeSaveRequestError(request, err)) throw Error('write_failed');
  return req.tool === 'delete_contact' ? { deleted: true } : view(contact);
}
// Which fixed step failed, so an unexpected error is diagnosable without exposing any data.
var stage = 'start', diagnostics = { status: null, containerCount: null };
function run() {
  try {
    var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var req = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)));
    var value = contacts(req);
    return JSON.stringify({ ok: true, value: value, diagnostics: diagnostics });
  } catch(error) {
    var allowed = ['permission_required','invalid_arguments','not_found','write_failed','read_failed','contact_scan_limit','contacts_unavailable'];
    return JSON.stringify({ ok: false, code: allowed.indexOf(error.message) >= 0 ? error.message : 'native_app_failed', diagnostics: diagnostics, stage: stage + '_' + String(error && error.name || 'error').toLowerCase().replace(/[^a-z]/g, '').slice(0, 20) });
  }
}
`;
