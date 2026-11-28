// The standard PAC functions (Netscape's original set, as browsers implement them). They run inside
// the QuickJS sandbox next to the untrusted script; only DNS and the local address come from the
// host, through `__pibotResolve` and `__pibotMyIp`, both answered from values resolved beforehand.
export const PAC_HELPERS = String.raw`
var __pibotWeekdays = "SUNMONTUEWEDTHUFRISAT";
var __pibotMonths = "JANFEBMARAPRMAYJUNJULAUGSEPOCTNOVDEC";
function alert() {}
function isPlainHostName(host) {
  return String(host).indexOf(".") < 0;
}
function dnsDomainIs(host, domain) {
  host = String(host).toLowerCase();
  domain = String(domain).toLowerCase();
  return host.length >= domain.length && host.substring(host.length - domain.length) === domain;
}
function localHostOrDomainIs(host, hostdom) {
  return host == hostdom || String(hostdom).lastIndexOf(host + ".", 0) === 0;
}
function dnsResolve(host) {
  return __pibotResolve(String(host));
}
function isResolvable(host) {
  return __pibotResolve(String(host)) !== null;
}
function myIpAddress() {
  return __pibotMyIp;
}
function dnsDomainLevels(host) {
  return String(host).split(".").length - 1;
}
function __pibotAddr(ip) {
  var bytes = String(ip).split(".");
  return (((bytes[0] & 0xff) << 24) | ((bytes[1] & 0xff) << 16) | ((bytes[2] & 0xff) << 8) | (bytes[3] & 0xff)) >>> 0;
}
function isInNet(ipaddr, pattern, maskstr) {
  var test = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ipaddr);
  if (!test) {
    ipaddr = dnsResolve(ipaddr);
    if (ipaddr === null) return false;
  } else if (test[1] > 255 || test[2] > 255 || test[3] > 255 || test[4] > 255) {
    return false;
  }
  var mask = __pibotAddr(maskstr);
  return ((__pibotAddr(ipaddr) & mask) >>> 0) === ((__pibotAddr(pattern) & mask) >>> 0);
}
function shExpMatch(url, pattern) {
  pattern = String(pattern).replace(/[.+^$(){}|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp("^" + pattern + "$").test(String(url));
}
function weekdayRange() {
  function day(name) {
    var i = __pibotWeekdays.indexOf(String(name).toUpperCase());
    return i >= 0 && i % 3 === 0 ? i / 3 : -1;
  }
  var argc = arguments.length;
  if (argc < 1) return false;
  var wday;
  if (arguments[argc - 1] === "GMT") {
    argc--;
    wday = new Date().getUTCDay();
  } else wday = new Date().getDay();
  var wd1 = day(arguments[0]);
  var wd2 = argc === 2 ? day(arguments[1]) : wd1;
  if (wd1 === -1 || wd2 === -1) return false;
  return wd1 <= wd2 ? wd1 <= wday && wday <= wd2 : wd2 >= wday || wday >= wd1;
}
function dateRange() {
  function month(name) {
    var i = __pibotMonths.indexOf(String(name).toUpperCase());
    return i >= 0 && i % 3 === 0 ? i / 3 : -1;
  }
  var argc = arguments.length;
  if (argc < 1) return false;
  var gmt = arguments[argc - 1] === "GMT";
  if (gmt) argc--;
  var now = new Date();
  if (gmt) now = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds());
  if (argc === 1) {
    var one = parseInt(arguments[0], 10);
    if (isNaN(one)) return now.getMonth() === month(arguments[0]);
    return one < 32 ? now.getDate() === one : now.getFullYear() === one;
  }
  var date1 = new Date(now.getFullYear(), 0, 1, 0, 0, 0);
  var date2 = new Date(now.getFullYear(), 11, 31, 23, 59, 59);
  var adjustMonth = false;
  var half = argc >> 1;
  for (var i = 0; i < argc; i++) {
    var target = i < half ? date1 : date2;
    var value = parseInt(arguments[i], 10);
    if (isNaN(value)) target.setMonth(month(arguments[i]));
    else if (value < 32) {
      if (i < half) adjustMonth = argc <= 2;
      target.setDate(value);
    } else target.setFullYear(value);
  }
  if (adjustMonth) {
    date1.setMonth(now.getMonth());
    date2.setMonth(now.getMonth());
  }
  return date1 <= date2 ? date1 <= now && now <= date2 : date2 >= now || now >= date1;
}
function timeRange() {
  var argc = arguments.length;
  if (argc < 1) return false;
  var gmt = arguments[argc - 1] === "GMT";
  if (gmt) argc--;
  var now = new Date();
  if (gmt) now = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds());
  if (argc === 1) return now.getHours() == arguments[0];
  if (argc === 2) return arguments[0] <= now.getHours() && now.getHours() < arguments[1];
  var date1 = new Date(now.getTime());
  var date2 = new Date(now.getTime());
  if (argc === 6) {
    date1.setHours(arguments[0], arguments[1], arguments[2]);
    date2.setHours(arguments[3], arguments[4], arguments[5]);
  } else if (argc === 4) {
    date1.setHours(arguments[0], arguments[1], 0);
    date2.setHours(arguments[2], arguments[3], 59);
  } else return false;
  return date1 <= date2 ? date1 <= now && now < date2 : date2 >= now || now >= date1;
}
`;
