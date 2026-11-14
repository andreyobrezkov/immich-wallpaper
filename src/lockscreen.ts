// Lock screen image through WinRT (Windows.System.UserProfile.LockScreen), called from Windows PowerShell 5.1,
// which can load WinRT types without extra packages.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.System.UserProfile.LockScreen, Windows.System.UserProfile, ContentType = WindowsRuntime]
$ext = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 }
$opTask = ($ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
$actTask = ($ext | Where-Object { $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
$t = $opTask.MakeGenericMethod([Windows.Storage.StorageFile]).Invoke($null, @([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:IW_LOCK_FILE)))
$t.Wait(-1) | Out-Null
$a = $actTask.Invoke($null, @([Windows.System.UserProfile.LockScreen]::SetImageFileAsync($t.Result)))
$a.Wait(-1) | Out-Null
'ok'
`;

export async function setLockScreen(file: string): Promise<void> {
  const { stdout } = await execFileP('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
    { windowsHide: true, timeout: 30_000, env: { ...process.env, IW_LOCK_FILE: file } });
  if (!stdout.includes('ok')) throw new Error(`lock screen: unexpected output ${stdout.trim()}`);
}
