# The Gentle Voice overlay window (T12, S5, S10). It runs inside the warm
# PowerShell host that lib/voice-overlay-windows.ts starts: the bootstrap reads
# this whole file from the first stdin line and evaluates it, then every other
# stdin line is one small command:
#
#   state <asleep|listening|transcribing|reading> <es|en> <label-base64|->
#   rec <0|1>      the microphone really records (listening only)
#   level <0-100>  the display level: the microphone while listening, the
#                  played speech while reading
#   quit
#
# `state` is answered `ok state` (or `error state`); the rest is fire and forget.
# The design is design/voice-overlay/03-bordes-y-pildora.html ("Bordes y pildora",
# the owner's choice); every size, opacity, colour and string below comes from it.
# All geometry is in the artboard's design units (one unit = one pixel at 100%)
# and scaled by the DPI of the monitor the window opens on.
#
# Honesty (S10): the screen-edge glow and the live wave are drawn only while
# `rec 1` holds. A listener that is awake but not recording shows the quiet
# resting pill, and no state at all (quit, closed stdin) means no window.
# Nothing here logs, stores or echoes a level, a label or a transcript.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Xaml

Add-Type -ReferencedAssemblies WindowsBase -TypeDefinition @"
using System;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Threading;

public static class VoiceOverlayNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public int Flags; }
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr hwnd, int index, int value);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);

  public static void Init() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }

  // Click-through, never activated, not in the taskbar or Alt+Tab, layered.
  public static void Harden(IntPtr hwnd) {
    const int GWL_EXSTYLE = -20;
    const int WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_LAYERED = 0x80000, WS_EX_NOACTIVATE = 0x08000000;
    SetWindowLong(hwnd, GWL_EXSTYLE, GetWindowLong(hwnd, GWL_EXSTYLE) | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_LAYERED | WS_EX_NOACTIVATE);
  }

  // Topmost, no activation, no focus change.
  public static void Place(IntPtr hwnd, int x, int y, int w, int h) {
    SetWindowPos(hwnd, new IntPtr(-1), x, y, w, h, 0x0010 | 0x0040);
  }

  // The monitor that holds the foreground window: left, top, width, height, dpi.
  public static int[] Monitor() {
    IntPtr monitor = MonitorFromWindow(GetForegroundWindow(), 2);
    MONITORINFO info = new MONITORINFO(); info.Size = Marshal.SizeOf(typeof(MONITORINFO));
    GetMonitorInfo(monitor, ref info);
    uint dx = 96, dy = 96;
    try { GetDpiForMonitor(monitor, 0, out dx, out dy); } catch { }
    return new int[] { info.Monitor.Left, info.Monitor.Top, info.Monitor.Right - info.Monitor.Left, info.Monitor.Bottom - info.Monitor.Top, (int)dx };
  }
}

// One reader thread: a line is queued and one dispatcher call drains the queue,
// so the window sleeps between commands and costs nothing while idle.
public static class VoiceStdinPump {
  public const string Eof = "\u0001eof";
  public static void Start(Dispatcher dispatcher, Action drain, ConcurrentQueue<string> queue) {
    Thread thread = new Thread(() => {
      string line;
      try { while ((line = Console.In.ReadLine()) != null) { queue.Enqueue(line); dispatcher.BeginInvoke(DispatcherPriority.Normal, drain); } } catch { }
      queue.Enqueue(Eof);
      dispatcher.BeginInvoke(DispatcherPriority.Normal, drain);
    });
    thread.IsBackground = true;
    thread.Start();
  }
}
"@

[VoiceOverlayNative]::Init()

# ---- design tokens (03-bordes-y-pildora.html) -------------------------------
$PALETTE = @{
  listening    = @('#E19CAA', '#D35E6B')
  transcribing = @('#E6BB62', '#E6BB62')
  reading      = @('#91BBA2', '#91BBA2')
  asleep       = @('#B0A29A', '#74524F')
}
$TEXT = '#F4EAE2'; $MUTED = '#B0A29A'; $SOFT = '#CFC3BB'; $INK = '#1A1116'; $PINK = '#E19CAA'; $BLUE = '#8EC6EE'; $BLUE_INK = '#10202C'
$MIRROR_BARS = 18
$reduced = -not [System.Windows.SystemParameters]::ClientAreaAnimation

$converter = New-Object System.Windows.Media.BrushConverter
function Brush([string]$hex) { $b = $converter.ConvertFromString($hex); $b.Freeze(); $b }
function Color([string]$hex) { [System.Windows.Media.ColorConverter]::ConvertFromString($hex) }
function Alpha([string]$hex, [double]$alpha) {
  $c = Color $hex; $c.A = [byte][Math]::Round(255 * $alpha); $c
}

$NS = 'xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"'
function Parse([string]$xaml) { [System.Windows.Markup.XamlReader]::Parse($xaml) }

# ---- windows ---------------------------------------------------------------
function New-OverlayWindow($content) {
  $w = New-Object System.Windows.Window
  $w.WindowStyle = 'None'; $w.AllowsTransparency = $true
  $w.Background = [System.Windows.Media.Brushes]::Transparent
  $w.ShowInTaskbar = $false; $w.ShowActivated = $false; $w.Topmost = $true
  $w.ResizeMode = 'NoResize'; $w.Focusable = $false; $w.IsHitTestVisible = $false
  $w.SizeToContent = 'Manual'; $w.UseLayoutRounding = $true
  $w.Content = $content
  $helper = New-Object System.Windows.Interop.WindowInteropHelper($w)
  $hwnd = $helper.EnsureHandle()
  # The extended styles are set before the first frame is ever shown.
  [VoiceOverlayNative]::Harden($hwnd)
  [pscustomobject]@{ Window = $w; Handle = $hwnd; Shown = $false }
}

function New-EdgeWindow([double]$x1, [double]$y1, [double]$x2, [double]$y2) {
  $rect = New-Object System.Windows.Shapes.Rectangle
  $g = New-Object System.Windows.Media.LinearGradientBrush
  $g.StartPoint = New-Object System.Windows.Point($x1, $y1); $g.EndPoint = New-Object System.Windows.Point($x2, $y2)
  $g.GradientStops.Add((New-Object System.Windows.Media.GradientStop((Color '#FFFFFF'), 0)))
  $g.GradientStops.Add((New-Object System.Windows.Media.GradientStop((Color '#00FFFFFF'), 1)))
  $rect.Fill = $g
  $o = New-OverlayWindow $rect
  $o | Add-Member -NotePropertyName Gradient -NotePropertyValue $g
  $o
}
$edges = @{
  top    = New-EdgeWindow 0 0 0 1
  bottom = New-EdgeWindow 0 1 0 0
  left   = New-EdgeWindow 0 0 1 0
  right  = New-EdgeWindow 1 0 0 0
}

# The transcribing sweep: a 420 x 10 amber bar with a 28 px glow, moved as a
# whole window so an animation frame never repaints a full-width surface.
$sweepRoot = Parse "<Grid $NS Width='476' Height='40'><Border Name='Bar' Width='420' Height='10' CornerRadius='5' HorizontalAlignment='Left' VerticalAlignment='Top' Margin='28,0,0,0' Background='#E6BB62'><Border.Effect><DropShadowEffect x:Name='Glow' BlurRadius='28' ShadowDepth='0' Color='#E6BB62' Opacity='1'/></Border.Effect></Border></Grid>"
$sweep = New-OverlayWindow $sweepRoot

# The pill: badge, label, session, mini wave, language chip; plus the resting
# and asleep forms. Every state reuses the same elements.
$pillXaml = @"
<Grid $NS Name='Box' Width='676' Height='160' TextOptions.TextFormattingMode='Ideal'>
  <Border Name='Pill' Margin='28' CornerRadius='22' BorderThickness='2' Background='#EB1A1116' BorderBrush='#D35E6B'>
    <Border.Effect><DropShadowEffect x:Name='Shadow' BlurRadius='24' ShadowDepth='0' Color='#D35E6B' Opacity='0.45'/></Border.Effect>
  </Border>
  <Grid Name='Active' Margin='54,28,54,28'>
    <Grid.ColumnDefinitions>
      <ColumnDefinition Width='Auto'/><ColumnDefinition Width='*'/><ColumnDefinition Width='Auto'/><ColumnDefinition Width='Auto'/>
    </Grid.ColumnDefinitions>
    <Grid Name='BadgeHost' Width='52' Height='52' VerticalAlignment='Center'>
      <Ellipse Name='BadgeDisc' Fill='#E19CAA'/>
      <Border Name='BadgeSq' CornerRadius='13' Background='#91BBA2'/>
      <Ellipse Name='BadgeRing' StrokeThickness='3' Stroke='#E6BB62' Fill='Transparent'/>
      <Viewbox Width='28' Height='28'>
        <Canvas Width='24' Height='24'>
          <Canvas Name='IcoMic'>
            <Path Name='MicA' Data='M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z' Stroke='#1A1116' StrokeThickness='1.8' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round'/>
            <Path Name='MicB' Data='M6 11v1a6 6 0 0 0 12 0v-1M12 18v3' Stroke='#1A1116' StrokeThickness='1.8' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round'/>
          </Canvas>
          <Canvas Name='IcoSpin' RenderTransformOrigin='0.5,0.5'>
            <Canvas.RenderTransform><RotateTransform x:Name='Spin' Angle='0'/></Canvas.RenderTransform>
            <Path Name='SpinA' Data='M12 3a9 9 0 1 1-9 9' Stroke='#E6BB62' StrokeThickness='1.8' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round'/>
          </Canvas>
          <Canvas Name='IcoSpk'>
            <Path Name='SpkA' Data='M4 9v6h4l5 4V5L8 9H4z' Stroke='#1A1116' StrokeThickness='1.8' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round'/>
            <Path Name='SpkB' Data='M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11' Stroke='#1A1116' StrokeThickness='1.8' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round'/>
          </Canvas>
        </Canvas>
      </Viewbox>
    </Grid>
    <StackPanel Grid.Column='1' Margin='16,3,0,0' VerticalAlignment='Center'>
      <StackPanel Name='Label' Orientation='Horizontal'/>
      <StackPanel Name='Session' Orientation='Horizontal' Margin='0,4,0,0'>
        <TextBlock Name='Prep' FontFamily='Segoe UI' FontSize='13' Foreground='#B0A29A' Margin='0,0,6,0' VerticalAlignment='Bottom' Padding='0,0,0,1'/>
        <TextBlock Name='Name' FontFamily='Segoe UI' FontSize='18' Foreground='#F4EAE2' TextTrimming='CharacterEllipsis' MaxWidth='260'/>
      </StackPanel>
    </StackPanel>
    <Canvas Name='Mini' Grid.Column='2' Width='120' Height='48' Margin='16,0,0,0' VerticalAlignment='Center'/>
    <Border Name='Chip' Grid.Column='3' Margin='16,0,0,0' VerticalAlignment='Center' CornerRadius='9' BorderThickness='2' Padding='13,8,13,8' BorderBrush='#E19CAA'>
      <TextBlock Name='ChipText' FontFamily='Cascadia Mono, Consolas' FontWeight='Bold' FontSize='24' LineHeight='24' LineStackingStrategy='BlockLineHeight' Foreground='#E19CAA' Text='ES'/>
    </Border>
  </Grid>
  <StackPanel Name='Rest' Orientation='Horizontal' HorizontalAlignment='Center' VerticalAlignment='Center'>
    <Viewbox Width='24' Height='24' VerticalAlignment='Center'>
      <Canvas Width='24' Height='24'>
        <Path Name='RestMoon' Data='M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z' Stroke='#B0A29A' StrokeThickness='1.8' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round'/>
        <Path Name='RestMic' Data='M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M6 11v1a6 6 0 0 0 12 0v-1M12 18v3' Stroke='#B0A29A' StrokeThickness='1.8' StrokeStartLineCap='Round' StrokeEndLineCap='Round' StrokeLineJoin='Round'/>
      </Canvas>
    </Viewbox>
    <StackPanel Name='RestTag' Orientation='Horizontal' Margin='12,0,0,0' VerticalAlignment='Center'/>
    <TextBlock Name='RestText' FontFamily='Segoe UI' FontSize='19' Foreground='#F4EAE2' Margin='12,0,0,0' VerticalAlignment='Center'/>
  </StackPanel>
</Grid>
"@
$pillRoot = Parse $pillXaml
$pill = New-OverlayWindow $pillRoot
$ui = @{}
foreach ($name in 'Box', 'Pill', 'Shadow', 'Active', 'BadgeDisc', 'BadgeSq', 'BadgeRing', 'IcoMic', 'IcoSpin', 'IcoSpk', 'MicA', 'MicB', 'SpinA', 'SpkA', 'SpkB', 'Spin', 'Label', 'Session', 'Prep', 'Name', 'Mini', 'Chip', 'ChipText', 'Rest', 'RestMoon', 'RestMic', 'RestTag', 'RestText') { $ui[$name] = $pillRoot.FindName($name) }
$ui.Box.LayoutTransform = New-Object System.Windows.Media.ScaleTransform(1, 1)
$sweepBorder = $sweepRoot.FindName('Bar'); $sweepGlow = $sweepRoot.FindName('Glow')
$sweepRoot.LayoutTransform = New-Object System.Windows.Media.ScaleTransform(1, 1)

# The mini wave: 18 bars across 120 x 48, gap 4, radius 2, minimum height 3.
$bars = @()
$barWidth = (120 - 17 * 4) / 18
for ($i = 0; $i -lt $MIRROR_BARS; $i++) {
  $r = New-Object System.Windows.Shapes.Rectangle
  $r.Width = $barWidth; $r.Height = 3; $r.RadiusX = 2; $r.RadiusY = 2
  [System.Windows.Controls.Canvas]::SetLeft($r, $i * ($barWidth + 4))
  $ui.Mini.Children.Add($r) | Out-Null
  $bars += $r
}

# Letter-spaced uppercase text (letter-spacing .1em), one TextBlock per glyph.
function Set-Spaced($panel, [string]$text, [double]$size, [string]$weight, [string]$hex) {
  $panel.Children.Clear()
  foreach ($ch in $text.ToUpperInvariant().ToCharArray()) {
    $t = New-Object System.Windows.Controls.TextBlock
    $t.Text = [string]$ch; $t.FontFamily = 'Segoe UI'; $t.FontSize = $size; $t.FontWeight = $weight
    $t.Foreground = Brush $hex; $t.Margin = New-Object System.Windows.Thickness(0, 0, ($size * 0.1), 0)
    $t.LineHeight = $size; $t.LineStackingStrategy = 'BlockLineHeight'
    $panel.Children.Add($t) | Out-Null
  }
}

# ---- state ------------------------------------------------------------------
$script:state = $null; $script:lang = 'es'; $script:label = ''
$script:rec = $false; $script:level = 0.0; $script:history = New-Object 'double[]' $MIRROR_BARS
$script:mon = $null; $script:scale = 1.0
$script:t0 = [Diagnostics.Stopwatch]::StartNew(); $script:last = 0.0
$script:env = 0.1; $script:phase = 0.0; $script:edgeOpacity = -1.0; $script:levelAt = -10.0; $script:sweepWidth = -1.0; $script:sweepMargin = -1.0; $script:edgeAt = -10.0

function Wpf-Dpi($w) { try { [System.Windows.Media.VisualTreeHelper]::GetDpi($w).DpiScaleX } catch { 1.0 } }

function Place($o, [double]$x, [double]$y, [double]$w, [double]$h, [bool]$show) {
  $wpf = Wpf-Dpi $o.Window
  $o.Window.Left = $x / $wpf; $o.Window.Top = $y / $wpf; $o.Window.Width = [Math]::Max(1, $w / $wpf); $o.Window.Height = [Math]::Max(1, $h / $wpf)
  if ($show) {
    if (-not $o.Shown) { $o.Window.Show(); $o.Shown = $true }
    [VoiceOverlayNative]::Place($o.Handle, [int][Math]::Round($x), [int][Math]::Round($y), [int][Math]::Round($w), [int][Math]::Round($h))
  }
}
function Hide-Window($o) { if ($o.Shown) { $o.Window.Hide(); $o.Shown = $false } }
function Hide-All { foreach ($e in $edges.Values) { Hide-Window $e }; Hide-Window $sweep; Hide-Window $pill }

function Set-EdgeColor($o, [string]$hex) {
  $o.Gradient.GradientStops[0].Color = Color $hex
  $o.Gradient.GradientStops[1].Color = Alpha $hex 0
}
function Show-Edges([string[]]$which, [double]$thickness, [string]$hex, [double]$opacity) {
  $m = $script:mon; $s = $script:scale
  $t = [Math]::Round($thickness * $s)
  foreach ($name in 'top', 'bottom', 'left', 'right') {
    $o = $edges[$name]
    if ($which -notcontains $name) { Hide-Window $o; continue }
    Set-EdgeColor $o $hex
    $o.Window.Opacity = $opacity
    switch ($name) {
      'top'    { Place $o $m[0] $m[1] $m[2] $t $true }
      'bottom' { Place $o $m[0] ($m[1] + $m[3] - $t) $m[2] $t $true }
      'left'   { Place $o $m[0] $m[1] $t $m[3] $true }
      'right'  { Place $o ($m[0] + $m[2] - $t) $m[1] $t $m[3] $true }
    }
  }
}

function Place-Pill([double]$w, [double]$h, [bool]$shadow) {
  $m = $script:mon; $s = $script:scale
  $boxW = ($w + 56) * $s; $boxH = ($h + 56) * $s
  $ui.Pill.Width = $w; $ui.Pill.Height = $h
  $ui.Box.Width = $w + 56; $ui.Box.Height = $h + 56
  $wpf = Wpf-Dpi $pill.Window
  $k = $s / $wpf
  $ui.Box.LayoutTransform = New-Object System.Windows.Media.ScaleTransform($k, $k)
  $ui.Shadow.Opacity = $(if ($shadow) { 0.45 } else { 0 })
  Place $pill ($m[0] + ($m[2] - $boxW) / 2) ($m[1] + ($m[3] - $boxH) / 2) $boxW $boxH $true
}

function Set-Palette([string]$c, [string]$b) {
  $ui.Pill.BorderBrush = Brush $b
  $ui.Shadow.Color = Color $b
  $ui.ChipText.Foreground = Brush $c
  $ui.Chip.BorderBrush = Brush $c
  $ui.Chip.Background = [System.Windows.Media.Brushes]::Transparent
  if ($script:lang -eq 'en') {
    # The English chip: filled blue with dark text, a little larger (T8 will
    # recolour the whole state; only the chip is drawn here).
    $ui.Chip.Background = Brush $BLUE; $ui.Chip.BorderBrush = Brush $BLUE; $ui.ChipText.Foreground = Brush $BLUE_INK; $ui.ChipText.FontSize = 28; $ui.ChipText.LineHeight = 28
  } else { $ui.ChipText.FontSize = 24; $ui.ChipText.LineHeight = 24 }
  $ui.ChipText.Text = $script:lang.ToUpperInvariant()
}

function Show-Session([string]$prep, [string]$fallback) {
  $name = if ($script:label) { $script:label } else { $fallback }
  if (-not $name) { $ui.Session.Visibility = 'Collapsed'; return }
  $ui.Session.Visibility = 'Visible'; $ui.Prep.Text = $prep; $ui.Name.Text = $name
}

function Show-Wave([string]$kind, [string]$hex) {
  $ui.Mini.Visibility = 'Visible'
  $ui.Mini.Tag = $kind
  foreach ($b in $bars) { $b.Fill = Brush $hex }
  Draw-Wave
}
function Draw-Wave {
  $mirror = $ui.Mini.Tag -eq 'mirror'
  for ($i = 0; $i -lt $MIRROR_BARS; $i++) {
    $h = [Math]::Max(3.0, [Math]::Min(1.0, $script:history[$i]) * 48)
    $bars[$i].Height = $h
    [System.Windows.Controls.Canvas]::SetTop($bars[$i], $(if ($mirror) { (48 - $h) / 2 } else { 48 - $h }))
  }
}

function Show-Badge([string]$kind, [string]$c) {
  foreach ($n in 'BadgeDisc', 'BadgeSq', 'BadgeRing', 'IcoMic', 'IcoSpin', 'IcoSpk') { $ui[$n].Visibility = 'Collapsed' }
  switch ($kind) {
    'disc' { $ui.BadgeDisc.Visibility = 'Visible'; $ui.BadgeDisc.Fill = Brush $c; $ui.IcoMic.Visibility = 'Visible' }
    'ring' { $ui.BadgeRing.Visibility = 'Visible'; $ui.BadgeRing.Stroke = Brush $c; $ui.IcoSpin.Visibility = 'Visible'; $ui.SpinA.Stroke = Brush $c }
    'sq'   { $ui.BadgeSq.Visibility = 'Visible'; $ui.BadgeSq.Background = Brush $c; $ui.IcoSpk.Visibility = 'Visible' }
  }
}

function Show-Resting([string]$paletteKey, [string]$tag, [string]$text, [bool]$moon) {
  $p = $PALETTE[$paletteKey]
  $ui.Active.Visibility = 'Collapsed'; $ui.Rest.Visibility = 'Visible'
  $ui.Pill.Background = New-Object System.Windows.Media.SolidColorBrush((Alpha $INK 0.86))
  $ui.Pill.BorderBrush = Brush $p[1]
  $ui.RestMoon.Visibility = $(if ($moon) { 'Visible' } else { 'Collapsed' })
  $ui.RestMic.Visibility = $(if ($moon) { 'Collapsed' } else { 'Visible' })
  Set-Spaced $ui.RestTag $tag 13 'Normal' $SOFT
  $ui.RestText.Inlines.Clear()
  if ($moon) {
    $ui.RestText.Inlines.Add((New-Object System.Windows.Documents.Run('di ')))
    $q = New-Object System.Windows.Documents.Run([string]::Concat([char]0xAB, 'Gentle Voice on', [char]0xBB))
    $q.Foreground = Brush $PINK; $q.FontWeight = 'SemiBold'
    $ui.RestText.Inlines.Add($q)
  } else { $ui.RestText.Inlines.Add((New-Object System.Windows.Documents.Run($text))) }
  Place-Pill 400 56 $false
}

function Stop-Animation { $timer.Stop() }
function Start-Animation { $script:last = $script:t0.Elapsed.TotalSeconds; if (-not $timer.IsEnabled) { $timer.Start() } }

# The one place a state becomes pixels. `fresh` re-picks the monitor.
function Apply([bool]$fresh) {
  $state = $script:state
  if ($fresh -or -not $script:mon) {
    $m = [VoiceOverlayNative]::Monitor()
    $script:mon = $m; $script:scale = [Math]::Max(0.5, $m[4] / 96.0)
  }
  Stop-Animation
  Hide-Window $sweep
  $script:sweepWidth = -1.0; $script:sweepMargin = -1.0
  $script:edgeOpacity = -1.0
  $ui.Active.Visibility = 'Visible'; $ui.Rest.Visibility = 'Collapsed'
  $ui.Pill.Background = New-Object System.Windows.Media.SolidColorBrush((Alpha $INK 0.92))
  switch ($state) {
    'asleep' {
      Show-Edges @() 0 '#000000' 0
      Show-Resting 'asleep' 'Dormido' '' $true
    }
    'listening' {
      if ($script:rec) {
        $p = $PALETTE.listening
        Show-Edges @('top', 'bottom', 'left', 'right') 72 $p[0] (0.2 + 0.55 * $script:level)
        Set-Palette $p[0] $p[1]
        Show-Badge 'disc' $p[0]
        Set-Spaced $ui.Label 'Escuchando' 22 'Bold' $p[0]
        Show-Session 'a' 'Gentle Voice'
        Show-Wave 'mirror' $p[0]
        Place-Pill 620 104 $true
        Start-Animation
      } else {
        # Awake, but nothing records: no glow, no wave, and no claim of listening.
        Show-Edges @() 0 '#000000' 0
        Show-Resting 'asleep' 'Voz activa' ([string]::Concat('micr', [char]0xF3, 'fono cerrado')) $false
      }
    }
    'transcribing' {
      $p = $PALETTE.transcribing
      Show-Edges @() 0 '#000000' 0
      Set-Palette $p[0] $p[1]
      Show-Badge 'ring' $p[0]
      Set-Spaced $ui.Label ([string]::Concat('Transcribiendo', [char]0x2026)) 22 'Bold' $p[0]
      Show-Session 'a' 'Gentle Voice'
      $ui.Mini.Visibility = 'Collapsed'
      Place-Pill 620 104 $true
      $sweepBorder.Background = Brush $p[0]; $sweepGlow.Color = Color $p[0]
      Move-Sweep ($(if ($reduced) { 528.0 } else { 0.0 }))
      if (-not $reduced) { Start-Animation }
    }
    'reading' {
      $p = $PALETTE.reading
      Show-Edges @('bottom') 96 $p[0] 0.85
      Set-Palette $p[0] $p[1]
      Show-Badge 'sq' $p[0]
      Set-Spaced $ui.Label 'Leyendo' 22 'Bold' $p[0]
      Show-Session 'de' ''
      [Array]::Clear($script:history, 0, $MIRROR_BARS)
      Show-Wave 'base' $p[0]
      Place-Pill 620 104 $true
      if (-not $reduced) { Start-Animation }
    }
  }
}

function Move-Sweep([double]$x) {
  $m = $script:mon; $s = $script:scale
  # Window = bar plus its glow, clamped to the monitor so no glow leaks next door.
  $left = $m[0] + ($x - 28) * $s; $right = $m[0] + ($x + 448) * $s
  $cl = [Math]::Max($m[0], $left); $cr = [Math]::Min($m[0] + $m[2], $right)
  $width = $cr - $cl
  if ($width -ne $script:sweepWidth) {
    # Only the clamped ends change the window's size; the middle of the sweep is
    # a plain move, which repaints nothing.
    $script:sweepWidth = $width
    $wpf = Wpf-Dpi $sweep.Window
    $sweepRoot.LayoutTransform = New-Object System.Windows.Media.ScaleTransform(($s / $wpf), ($s / $wpf))
    $sweepRoot.Width = $width / $s
    $sweep.Window.Width = [Math]::Max(1, $width / $wpf); $sweep.Window.Height = 40 * $s / $wpf
  }
  $margin = ($m[0] + $x * $s - $cl) / $s
  if ($margin -ne $script:sweepMargin) { $script:sweepMargin = $margin; $sweepBorder.Margin = New-Object System.Windows.Thickness($margin, 0, 0, 0) }
  if (-not $sweep.Shown) { $sweep.Window.Show(); $sweep.Shown = $true }
  [VoiceOverlayNative]::Place($sweep.Handle, [int][Math]::Round($cl), $m[1], [int][Math]::Round($width), [int][Math]::Round(40 * $s))
}

# ---- animation ---------------------------------------------------------------
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(50)
$timer.Add_Tick({
  try {
    $now = $script:t0.Elapsed.TotalSeconds; $dt = [Math]::Min(0.2, $now - $script:last); $script:last = $now
    switch ($script:state) {
      'listening' {
        for ($i = 0; $i -lt $MIRROR_BARS - 1; $i++) { $script:history[$i] = $script:history[$i + 1] }
        $script:history[$MIRROR_BARS - 1] = $script:level
        Draw-Wave
        # The four edges are repainted at most about 12 times a second, and only
        # for a visible change: they are the expensive part of the window.
        $opacity = 0.2 + 0.55 * $script:level
        if ([Math]::Abs($opacity - $script:edgeOpacity) -ge 0.02 -and $now - $script:edgeAt -ge 0.075) {
          $script:edgeOpacity = $opacity; $script:edgeAt = $now
          foreach ($e in $edges.Values) { $e.Window.Opacity = $opacity }
        }
      }
      'transcribing' {
        $ui.Spin.Angle = ($now / 1.1 % 1.0) * 360
        # 1.8 s ease-in-out, alternating, across the monitor.
        $p = ($now % 3.6) / 1.8; if ($p -gt 1) { $p = 2 - $p }
        $e = if ($p -lt 0.5) { 2 * $p * $p } else { 1 - [Math]::Pow(-2 * $p + 2, 2) / 2 }
        $travel = $script:mon[2] / $script:scale - 420
        Move-Sweep ($e * $travel)
      }
      'reading' {
        # The bars follow the level of the speech the player really started,
        # like listening. Only when none has arrived for 300 ms (a player that
        # does not publish one) a gentle synthesized motion keeps the bars alive.
        $script:phase += $dt
        if ($now - $script:levelAt -lt 0.3) { $value = $script:level }
        else {
          $target = 0.10 + 0.20 * (0.5 + 0.5 * [Math]::Sin($script:phase * 2 * [Math]::PI * 1.6)) * (0.85 + 0.15 * (Get-Random -Maximum 1.0))
          $script:env += ($target - $script:env) * 0.25
          $value = $script:env
        }
        for ($i = 0; $i -lt $MIRROR_BARS - 1; $i++) { $script:history[$i] = $script:history[$i + 1] }
        $script:history[$MIRROR_BARS - 1] = $value
        Draw-Wave
      }
    }
  } catch { }
})

# ---- commands ---------------------------------------------------------------
$queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$validStates = 'asleep', 'listening', 'transcribing', 'reading'
function Shutdown {
  try { $timer.Stop(); Hide-All } catch { }
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.InvokeShutdown()
}
function Handle([string]$line) {
  if ($line.Length -gt 512) { return }
  $parts = $line.Trim().Split(' ')
  switch ($parts[0]) {
    'state' {
      try {
        if ($parts.Count -ne 4 -or $validStates -notcontains $parts[1] -or @('es', 'en') -notcontains $parts[2]) { throw 'bad state' }
        $label = ''
        if ($parts[3] -ne '-') { $label = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[3])) -replace '[\p{C}]', ''; if ($label.Length -gt 48) { $label = $label.Substring(0, 48) } }
        $script:state = $parts[1]; $script:lang = $parts[2]; $script:label = $label
        $script:rec = $false; $script:level = 0.0; $script:levelAt = -10.0
        [Array]::Clear($script:history, 0, $MIRROR_BARS)
        Apply $true
        [Console]::Out.WriteLine('ok state')
      } catch { [Console]::Error.WriteLine('overlay: ' + $_.Exception.Message); [Console]::Out.WriteLine('error state') }
    }
    'rec' {
      if ($script:state -eq 'listening' -and $parts.Count -eq 2) {
        $on = $parts[1] -eq '1'
        if ($on -ne $script:rec) { $script:rec = $on; $script:level = 0.0; [Array]::Clear($script:history, 0, $MIRROR_BARS); try { Apply $false } catch { } }
      }
    }
    'level' {
      $n = 0
      if ($parts.Count -eq 2 -and [int]::TryParse($parts[1], [ref]$n)) { $script:level = [Math]::Max(0, [Math]::Min(100, $n)) / 100.0; $script:levelAt = $script:t0.Elapsed.TotalSeconds }
    }
    'quit' { Shutdown }
  }
}
$drain = [Action]{
  $line = $null
  while ($queue.TryDequeue([ref]$line)) {
    if ($line -eq [VoiceStdinPump]::Eof) { Shutdown; return }
    Handle $line
  }
}
[VoiceStdinPump]::Start([System.Windows.Threading.Dispatcher]::CurrentDispatcher, $drain, $queue)
[Console]::Out.WriteLine('ok ready')
[System.Windows.Threading.Dispatcher]::Run()
