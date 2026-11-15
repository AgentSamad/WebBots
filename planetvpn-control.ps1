param([string]$Action = "connect")
# Controls Planet VPN GUI via UIAutomation (falls back to coordinate click)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinUtil {
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint b, int e);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$proc = Get-Process "PlanetVPN" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Error "PlanetVPN process not found"; exit 1 }

$hwnd = $proc.MainWindowHandle
[WinUtil]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
[WinUtil]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 800

# --- Try UIAutomation first ---
try {
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $pidCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$proc.Id)
    $win = $desktop.FindFirst([System.Windows.Automation.TreeScope]::Children, $pidCond)

    if ($win) {
        $btnType = [System.Windows.Automation.ControlType]::Button
        $btnCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $btnType)
        $buttons = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)

        # Retry loop — 'Disconnect' only appears after VPN fully connects (not during 'Connecting...')
        $target = $null
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline -and -not $target) {
            $buttons = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
            foreach ($b in $buttons) {
                $n = $b.Current.Name
                if ($n) { Write-Host "Button: '$n'" }
                if ($Action -eq "connect"    -and $n -match "(?i)^connect$")    { $target = $b; break }
                if ($Action -eq "disconnect" -and $n -match "(?i)^disconnect$") { $target = $b; break }
            }
            if (-not $target) { Start-Sleep -Milliseconds 1500 }
        }

        if ($target) {
            $ip = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $ip.Invoke()
            Write-Host "UIAutomation: invoked '$($target.Current.Name)'"
            exit 0
        } else {
            Write-Host "UIAutomation: '$Action' button not found after 30s, falling back to coordinates"
        }
    }
} catch {
    Write-Host "UIAutomation error: $_"
}

# --- Fallback: click at relative coordinates ---
$rect = New-Object WinUtil+RECT
[WinUtil]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right  - $rect.Left
$h = $rect.Bottom - $rect.Top

# Connect button is ~65% from left, ~62% from top (measured from screenshot)
$cx = $rect.Left + [int]($w * 0.65)
$cy = $rect.Top  + [int]($h * 0.62)

Write-Host "Coordinate click at ($cx,$cy)  window=($($rect.Left),$($rect.Top)) ${w}x${h}"
[WinUtil]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 300
[WinUtil]::mouse_event(0x0002, 0, 0, 0, 0)   # MOUSEEVENTF_LEFTDOWN
Start-Sleep -Milliseconds 120
[WinUtil]::mouse_event(0x0004, 0, 0, 0, 0)   # MOUSEEVENTF_LEFTUP
Write-Host "Done"
