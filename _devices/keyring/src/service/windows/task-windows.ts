import type { WindowsServicePaths } from "./paths-windows.js";
import { LOCAL_SERVICE_SID } from "./paths-windows.js";

// The scheduled task that runs the service: at startup, as LOCAL SERVICE (looked up by SID, so a localised Windows names
// it right), restarted every minute it stops, never stopped for running long or on battery. A task rather than a Windows
// service because the keyring is a compiled script, which cannot answer the service manager's start handshake; Task
// Scheduler runs it as that account all the same. Its input arrives as $KeyringInput (powershell.ts).

export const REGISTER_TASK_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $account = (New-Object System.Security.Principal.SecurityIdentifier('${LOCAL_SERVICE_SID}')).Translate([System.Security.Principal.NTAccount]).Value
  $action = New-ScheduledTaskAction -Execute $KeyringInput.exe -Argument ('service run --user ' + $KeyringInput.sid)
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId $account -LogonType ServiceAccount -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskPath $KeyringInput.taskPath -TaskName $KeyringInput.taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Stop-ScheduledTask -TaskPath $KeyringInput.taskPath -TaskName $KeyringInput.taskName -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskPath $KeyringInput.taskPath -TaskName $KeyringInput.taskName
  [Console]::Out.WriteLine('intentic-keyring>' + (@{ ok = $true } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.WriteLine('intentic-keyring>' + (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
}
`;

// Stopped, not removed: a running task holds the program open, so a new copy can land only once it has stopped.
export const STOP_TASK_SCRIPT = `
try {
  Stop-ScheduledTask -TaskPath $KeyringInput.taskPath -TaskName $KeyringInput.taskName -ErrorAction SilentlyContinue
} catch {
  # A task that is not there, or not running, has nothing to stop; said on stderr for the install's own record.
  [Console]::Error.WriteLine('stop: ' + $_.Exception.Message)
}
[Console]::Out.WriteLine('intentic-keyring>' + (@{ ok = $true } | ConvertTo-Json -Compress))
`;

export const UNREGISTER_TASK_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Stop-ScheduledTask -TaskPath $KeyringInput.taskPath -TaskName $KeyringInput.taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskPath $KeyringInput.taskPath -TaskName $KeyringInput.taskName -Confirm:$false -ErrorAction SilentlyContinue
  [Console]::Out.WriteLine('intentic-keyring>' + (@{ ok = $true } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.WriteLine('intentic-keyring>' + (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
}
`;

export const taskInput = (paths: WindowsServicePaths, sid: string) => ({ exe: paths.exe, sid, taskPath: paths.taskPath, taskName: paths.taskName });

// Task Scheduler's \Intentic\ folder, removed once no task (hidden ones included) and no subfolder is left in it: the
// last user's uninstall (leftovers-windows.ts). A folder already gone is no failure.
export const REMOVE_TASK_FOLDER_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $name = $KeyringInput.taskPath.Trim('\\')
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  $removed = $false
  try { $folder = $service.GetFolder('\\' + $name) } catch { $folder = $null }
  if ($folder -ne $null -and $folder.GetTasks(1).Count -eq 0 -and $folder.GetFolders(0).Count -eq 0) {
    $service.GetFolder('\\').DeleteFolder($name, 0)
    $removed = $true
  }
  [Console]::Out.WriteLine('intentic-keyring>' + (@{ ok = $true; removed = $removed } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.WriteLine('intentic-keyring>' + (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
}
`;
