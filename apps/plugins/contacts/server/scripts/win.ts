// Classic Outlook only. New Outlook has no COM automation API.
export const CONTACTS_WINDOWS_SCRIPT = `
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
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $a = $request.args
  try { $outlook = Track (New-Object -ComObject Outlook.Application); $session = Track ($outlook.GetNamespace('MAPI')) }
  catch { @{ ok = $false; code = (OutlookFailure $_.Exception) } | ConvertTo-Json -Compress; exit 0 }
  $folder = Track ($session.GetDefaultFolder(10))
  if ($null -eq $folder) { throw 'contacts_unavailable' }
  $items = Track ($folder.Items)
  if ($null -eq $items) { throw 'contacts_unavailable' }
  $offset = 0
  $cursor = ([string]$a.cursor).Trim()
  if ($cursor -match '^[0-9]{1,6}$' -and [int]$cursor -le 100000) { $offset = [int]$cursor }
  if ($request.tool -eq 'check') { $value = @{ supported = $true; driver = 'outlook'; readOnly = $false } }
  elseif ($request.tool -eq 'count_contacts') {
    $total = 0; $scan = 0
    foreach ($contact in $items) { $null = Track $contact; if (++$scan -gt 10000) { throw 'contact_scan_limit' }; if ($contact.Class -eq 40) { $total++ } }
    $value = @{ total = $total }
  }
  elseif ($request.tool -eq 'list_contacts') {
    $limit = 50; if ($null -ne $a.limit) { $limit = [int]$a.limit }; if ($limit -lt 1 -or $limit -gt 100) { throw 'invalid_arguments' }
    $items.Sort('[FullName]'); $result = @(); $index = $offset + 1; $scan = 0
    while ($index -le $items.Count -and $result.Count -lt $limit -and $scan++ -lt 1000) {
      $contact = Track ($items.Item($index)); $index++
      if ($contact.Class -ne 40) { continue }
      $result += @{ id = $contact.EntryID; givenName = $contact.FirstName; familyName = $contact.LastName; organization = $contact.CompanyName }
    }
    $value = @{ items = $result; nextCursor = $(if ($index -le $items.Count) { [string]($index - 1) } else { $null }) }
  }
  elseif ($request.tool -eq 'search_contacts') {
    $query = [string]$a.query; if ($query.Length -lt 1 -or $query.Length -gt 256) { throw 'invalid_arguments' }
    $limit = 50; if ($a.limit) { $limit = [int]$a.limit }; if ($limit -lt 1 -or $limit -gt 100) { throw 'invalid_arguments' }
    $result = @(); $seen = 0; $more = $false; $scan = 0; $digits = ''; if ($query -match '^[+0-9 .()-]+$') { $digits = $query -replace '[^0-9]', '' }
    foreach ($contact in $items) { $null = Track $contact; if (++$scan -gt 10000) { throw 'contact_scan_limit' }; if ($contact.Class -ne 40) { continue }; $emails = @($contact.Email1Address, $contact.Email2Address, $contact.Email3Address); $phones = @($contact.MobileTelephoneNumber, $contact.BusinessTelephoneNumber, $contact.Business2TelephoneNumber, $contact.HomeTelephoneNumber, $contact.Home2TelephoneNumber, $contact.OtherTelephoneNumber); $matched = @(@([string]$contact.FullName, [string]$contact.CompanyName) + $emails | Where-Object { ([string]$_).IndexOf($query, [StringComparison]::OrdinalIgnoreCase) -ge 0 }).Count -gt 0; if (-not $matched -and $digits.Length -gt 0) { $matched = @($phones | Where-Object { (([string]$_) -replace '[^0-9]', '').Contains($digits) }).Count -gt 0 }; if (-not $matched) { continue }; if ($seen++ -lt $offset) { continue }; if ($result.Count -ge $limit) { $more = $true; break }; $result += @{ id = $contact.EntryID; givenName = $contact.FirstName; familyName = $contact.LastName; organization = $contact.CompanyName; emails = $emails; phones = $phones } }
    $value = @{ items = $result; nextCursor = $(if ($more) { [string]($offset + $result.Count) } else { $null }) }
  }
  else {
    $creating = $request.tool -eq 'create_contact'
    $item = Track $(if ($creating) { $outlook.CreateItem(2) } else { $session.GetItemFromID([string]$a.id) })
    # MAPI EntryIDs address any Outlook item; a contact operation must never mutate mail.
    if ($null -eq $item -or $item.Class -ne 40) { throw 'not_found' }
    if (-not $creating) {
      $parent = Track ($item.Parent)
      if ($null -eq $parent -or $parent.EntryID -ne $folder.EntryID -or $parent.StoreID -ne $folder.StoreID) { throw 'not_found' }
    }
    if ($request.tool -eq 'delete_contact') { $item.Delete(); $value = @{ deleted = $true } }
    else {
      if ($null -ne $a.givenName) { $item.FirstName = [string]$a.givenName }; if ($null -ne $a.familyName) { $item.LastName = [string]$a.familyName }; if ($null -ne $a.organization) { $item.CompanyName = [string]$a.organization }; if ($null -ne $a.email) { $item.Email1Address = [string]$a.email }; if ($null -ne $a.phone) { $item.MobileTelephoneNumber = [string]$a.phone }
      $item.Save(); $value = @{ id = $item.EntryID; saved = $true }
    }
  }
  @{ ok = $true; value = $value } | ConvertTo-Json -Depth 10 -Compress
} catch {
  $allowed = @('invalid_arguments','not_found','contact_scan_limit','contacts_unavailable')
  $code = if ($request.tool -in @('list_contacts','search_contacts')) { 'read_failed' } else { 'native_app_failed' }; if ($allowed -contains $_.Exception.Message) { $code = $_.Exception.Message }
  @{ ok = $false; code = $code } | ConvertTo-Json -Compress
} finally {
  # The same COM wrapper may appear twice; final cleanup ignores an already released wrapper.
  for ($i = $objects.Count - 1; $i -ge 0; $i--) { try { if ([Runtime.InteropServices.Marshal]::IsComObject($objects[$i])) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($objects[$i]) } } catch { <# An already released wrapper is safe to skip. #> }
}
`;
