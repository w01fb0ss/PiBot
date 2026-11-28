// Classic Outlook only. New Outlook has no COM automation API.
export const CALENDAR_WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$objects = [System.Collections.Generic.List[object]]::new()
function Track($value) { if ($null -ne $value) { $objects.Add($value) }; return ,$value }
function OutlookFailure($exception) {
  # PowerShell wraps COM exceptions; inspect fixed HRESULTs, never return exception text.
  for ($depth = 0; $null -ne $exception -and $depth -lt 8; $depth++) {
    $hresult = $exception.HResult.ToString('X8')
    if ($hresult -eq '80040154' -or $hresult -eq '800401F3') { return 'outlook_missing' }
    if ($hresult -eq '80070005') { return 'outlook_access_denied' }
    $exception = $exception.InnerException
  }
  return 'native_app_failed'
}
# Keep discovery bounded and retain wrappers until the existing finally releases them.
function ReadableCalendars($session) {
  $pending = [System.Collections.Generic.Queue[object]]::new()
  $roots = Track ($session.Folders)
  if ($roots.Count -gt 512) { throw 'read_failed' }
  foreach ($root in $roots) { $pending.Enqueue(@{ folder = (Track $root); depth = 0 }) }
  $seen = [System.Collections.Generic.HashSet[string]]::new()
  $found = [System.Collections.Generic.List[object]]::new()
  while ($pending.Count -gt 0) {
    $node = $pending.Dequeue(); $current = $node.folder
    if ($seen.Count -ge 512 -or $node.depth -gt 16) { throw 'read_failed' }
    try {
      $id = [string]$current.EntryID; $storeId = [string]$current.StoreID
      if (-not $seen.Add($storeId + ':' + $id)) { continue }
      if ($current.DefaultItemType -eq 1) {
        $accessor = Track ($current.PropertyAccessor)
        $rights = [int]$accessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x0FF40003')
        if (($rights -band 2) -ne 0) {
          if ($found.Count -ge 100) { throw 'read_failed' }
          $found.Add(@{ folder = $current; id = $id; title = [string]$current.Name; writable = (($rights -band 17) -ne 0) })
        }
      }
      $children = Track ($current.Folders)
      if ($pending.Count + $seen.Count + $children.Count -gt 512) { throw 'read_failed' }
      foreach ($child in $children) { $pending.Enqueue(@{ folder = (Track $child); depth = ($node.depth + 1) }) }
    } catch {
      # An inaccessible subtree is not readable; unexpected failures must not masquerade as empty.
      if ((OutlookFailure $_.Exception) -ne 'outlook_access_denied') { throw }
    }
  }
  return ,$found
}
function SelectedCalendarIds($a) {
  if ($null -ne $a.calendarIds -and $null -ne $a.calendarId) { throw 'invalid_arguments' }
  if ($null -ne $a.calendarIds) {
    if ($a.calendarIds -isnot [array] -or $a.calendarIds.Count -lt 1 -or $a.calendarIds.Count -gt 100) { throw 'invalid_arguments' }
    $ids = @($a.calendarIds)
  } elseif ($null -ne $a.calendarId) { $ids = @($a.calendarId) } else { return $null }
  $unique = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($id in $ids) {
    if ($id -isnot [string] -or $id.Length -lt 1 -or $id.Length -gt 4096 -or -not $unique.Add($id)) { throw 'invalid_arguments' }
  }
  return ,$ids
}
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $a = $request.args
  try { $outlook = Track (New-Object -ComObject Outlook.Application); $session = Track ($outlook.GetNamespace('MAPI')) }
  catch { @{ ok = $false; code = (OutlookFailure $_.Exception) } | ConvertTo-Json -Compress; exit 0 }
  if ($request.tool -eq 'check') { $folder = Track ($session.GetDefaultFolder(9)); $value = @{ supported = $true; driver = 'outlook'; readOnly = $false } }
  elseif ($request.tool -eq 'list_calendars') {
    $calendars = ReadableCalendars $session
    $value = @{ items = @($calendars | ForEach-Object { @{ id = $_.id; title = $_.title; writable = $_.writable } }) }
  }
  elseif ($request.tool -eq 'list_events') {
    $start = [DateTimeOffset]::Parse($a.start); $end = [DateTimeOffset]::Parse($a.end)
    if ($end -le $start -or ($end - $start).TotalDays -gt 31) { throw 'invalid_arguments' }
    $ids = SelectedCalendarIds $a
    $calendars = ReadableCalendars $session
    $selected = @($calendars | Where-Object { $null -eq $ids -or $ids -ccontains $_.id })
    if ($null -ne $ids -and $selected.Count -ne $ids.Count) { throw 'not_found' }
    $offset = 0
    $cursor = ([string]$a.cursor).Trim()
    if ($cursor -match '^[0-9]{1,6}$' -and [int]$cursor -le 100000) { $offset = [int]$cursor }
    $limit = 50; if ($null -ne $a.limit) { $limit = [int]$a.limit }; if ($offset -lt 0 -or $offset -gt 100000 -or $limit -lt 1 -or $limit -gt 100) { throw 'invalid_arguments' }
    $filter = "[Start] < '" + $end.LocalDateTime.ToString('g', [cultureinfo]::GetCultureInfo('en-US')) + "' AND [End] > '" + $start.LocalDateTime.ToString('g', [cultureinfo]::GetCultureInfo('en-US')) + "'"
    $events = [System.Collections.Generic.List[object]]::new()
    foreach ($calendar in $selected) {
      $items = Track ($calendar.folder.Items)
      $items.Sort('[Start]'); $items.IncludeRecurrences = $true
      $filtered = Track ($items.Restrict($filter))
      foreach ($event in $filtered) {
        $null = Track $event
        if ($events.Count -ge 100000) { throw 'read_failed' }
        # Keep metadata for sorting only; never read bodies for events outside the returned page.
        $events.Add(@{ event = $event; calendar = $calendar; start = $event.StartUTC; id = [string]$event.EntryID })
      }
    }
    $ordered = @($events | Sort-Object -Property start, @{ Expression = { $_.calendar.id } }, id)
    $result = @($ordered | Select-Object -Skip $offset -First $limit | ForEach-Object {
      $event = $_.event; $calendar = $_.calendar
      @{ id = $_.id; title = $event.Subject; start = $event.StartUTC.ToString('o'); end = $event.EndUTC.ToString('o'); calendarId = $calendar.id; calendarName = $calendar.title; calendarWritable = $calendar.writable; location = $event.Location; notes = $event.Body; allDay = $event.AllDayEvent }
    })
    $value = @{ items = $result; nextCursor = $(if ($offset + $result.Count -lt $ordered.Count) { [string]($offset + $result.Count) } else { $null }) }
  }
  else {
    $folder = Track ($session.GetDefaultFolder(9))
    $creating = $request.tool -eq 'create_event'
    $item = Track $(if ($creating) { $outlook.CreateItem(1) } else { $session.GetItemFromID([string]$a.id) })
    # MAPI EntryIDs address any Outlook item; a calendar operation must never mutate mail.
    if ($null -eq $item -or $item.Class -ne 26) { throw 'not_found' }
    if (-not $creating) {
      $parent = Track ($item.Parent)
      if ($null -eq $parent -or $parent.EntryID -ne $folder.EntryID -or $parent.StoreID -ne $folder.StoreID) { throw 'not_found' }
      # An EntryID alone cannot bind one occurrence; never turn a one-event draft into a series write.
      if ($item.IsRecurring -or $item.RecurrenceState -ne 0) { throw 'recurring_event_unsupported' }
    }
    if ($item.MeetingStatus -ne 0) { throw 'attendee_event_unsupported' }
    if ($request.tool -eq 'delete_event') { $item.Delete(); $value = @{ deleted = $true } }
    else {
      if ($a.calendarId -and $a.calendarId -ne $folder.EntryID) { throw 'not_found' }
      if ($null -ne $a.title) { $item.Subject = [string]$a.title }; if ($null -ne $a.start) { $item.StartUTC = [DateTimeOffset]::Parse($a.start).UtcDateTime }; if ($null -ne $a.end) { $item.EndUTC = [DateTimeOffset]::Parse($a.end).UtcDateTime }; if ($item.EndUTC -le $item.StartUTC) { throw 'invalid_arguments' }; if ($null -ne $a.notes) { $item.Body = [string]$a.notes }; if ($null -ne $a.location) { $item.Location = [string]$a.location }; if ($null -ne $a.allDay) { $item.AllDayEvent = [bool]$a.allDay }
      $item.Save(); $value = @{ id = $item.EntryID; saved = $true }
    }
  }
  @{ ok = $true; value = $value } | ConvertTo-Json -Depth 10 -Compress
} catch {
  $allowed = @('invalid_arguments','not_found','attendee_event_unsupported','recurring_event_unsupported','read_failed')
  $code = OutlookFailure $_.Exception; if ($allowed -contains $_.Exception.Message) { $code = $_.Exception.Message }
  @{ ok = $false; code = $code } | ConvertTo-Json -Compress
} finally {
  # The same COM wrapper may appear twice; final cleanup ignores an already released wrapper.
  for ($i = $objects.Count - 1; $i -ge 0; $i--) { try { if ([Runtime.InteropServices.Marshal]::IsComObject($objects[$i])) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($objects[$i]) } } catch { <# An already released wrapper is safe to skip. #> }
}
`;
