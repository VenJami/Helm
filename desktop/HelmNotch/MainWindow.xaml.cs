using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Web.WebView2.Core;

namespace HelmNotch;

/// <summary>
/// The notch window: frameless, drop-shaped, always on top, hosting Helm's own
/// /hud page. Everything visible is drawn by that page's CSS — this class only
/// does the things a web page cannot do for itself: be a real OS window, stay
/// above other apps, move when dragged, and hug its own content.
/// </summary>
public partial class MainWindow : Window
{
    // Same folder Helm keeps its other local state in, so the browser profile
    // this window needs doesn't land somewhere surprising.
    private static readonly string UserDataFolder = System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Helm",
        "notch-webview"
    );

    private readonly string _url;
    private int _loadAttempts;

    public MainWindow(string url)
    {
        _url = url;
        InitializeComponent();
        SourceInitialized += OnSourceInitialized;
        Loaded += OnLoaded;
    }

    /// <summary>
    /// Cut the window to shape, the moment it has a handle.
    ///
    /// Deliberately NOT WPF's AllowsTransparency. That flag hosts the window as
    /// a LAYERED window: it renders perfectly - alpha corners, drop shadow, the
    /// lot - and then swallows every mouse message the hosted WebView2 should
    /// have received. Shipped once; the notch could not be clicked or closed.
    /// Verified by A/B: with AllowsTransparency on, WS_EX_LAYERED is set and a
    /// synthetic click at the window's centre never reaches the page; with it
    /// off, the same click arrives. A region gives us the silhouette instead,
    /// and costs no input.
    /// </summary>
    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return;
        // Tell DWM to leave the corners alone: it can only round all four, and
        // the notch wants a square top (so it sits flush against the screen
        // edge) with a rounded bottom. ApplyShape does that with a region.
        var noRound = DWMWCP_DONOTROUND;
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ref noRound, sizeof(int));
        ApplyShape();
    }

    /// <summary>
    /// The notch's silhouette: square along the top so it meets the top of the
    /// screen with no seam, generously rounded along the bottom so it reads as
    /// a drop hanging off the edge.
    ///
    /// A window REGION rather than DWM's corner preference, because that one
    /// rounds all four corners or none, and rather than CSS, because CSS can
    /// only round what it paints INSIDE the window - the window's own corners
    /// would still be there, square and opaque, behind the rounding.
    /// Region coordinates are physical pixels, so everything here is scaled by
    /// the window's DPI; WPF's Width/Height are device-independent.
    /// </summary>
    private void ApplyShape()
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return;
        if (!GetWindowRect(hwnd, out var r)) return;
        int w = r.Right - r.Left;
        int h = r.Bottom - r.Top;
        if (w <= 0 || h <= 0) return;

        var dpi = VisualTreeHelper.GetDpi(this);
        int radius = (int)Math.Round(BottomRadiusDip * dpi.DpiScaleY);
        // Never round more than half the window, or the shape inverts.
        radius = Math.Max(0, Math.Min(radius, Math.Min(w / 2, h / 2)));
        if (radius == 0)
        {
            SetWindowRgn(hwnd, IntPtr.Zero, true);
            return;
        }

        // Round-rect (all four corners) OR a rectangle covering the top strip -
        // the union squares the top two corners back off and leaves the bottom
        // two rounded.
        var shape = CreateRoundRectRgn(0, 0, w + 1, h + 1, radius * 2, radius * 2);
        var topStrip = CreateRectRgn(0, 0, w + 1, radius + 1);
        CombineRgn(shape, shape, topStrip, RGN_OR);
        DeleteObject(topStrip);
        // SetWindowRgn takes ownership of `shape` on success - do NOT delete it.
        if (SetWindowRgn(hwnd, shape, true) == 0) DeleteObject(shape);
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        PlaceAtTopCentre();

        // Match the window's own colour so there is no white flash before the
        // page paints. Not Transparent: without a layered window there is
        // nothing behind it to show through, and the page fills the frame.
        Web.DefaultBackgroundColor = System.Drawing.ColorTranslator.FromHtml("#141416");

        // HELMNOTCH_DEBUG_PORT exposes the hosted page over the DevTools
        // protocol. Off unless asked for, and the only way to drive this window
        // from a test: it has no automation surface of its own, and clicking a
        // real button beats guessing at screen coordinates.
        var debugPort = Environment.GetEnvironmentVariable("HELMNOTCH_DEBUG_PORT");
        CoreWebView2EnvironmentOptions? options = null;
        if (!string.IsNullOrWhiteSpace(debugPort))
        {
            options = new CoreWebView2EnvironmentOptions
            {
                AdditionalBrowserArguments = $"--remote-debugging-port={debugPort}",
            };
        }
        var env = await CoreWebView2Environment.CreateAsync(null, UserDataFolder, options);
        await Web.EnsureCoreWebView2Async(env);

        var core = Web.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDevToolsEnabled = true; // local tool; keeps this debuggable
        core.WebMessageReceived += OnWebMessage;
        core.NavigationCompleted += OnNavigationCompleted;

        Web.Source = new Uri(_url);
        StartWatching();
    }

    /// <summary>
    /// Helm may not be listening yet (the notch can be started first, or the
    /// server restarted under it). Retry rather than sit on a browser error
    /// page, which would be a baffling thing to find floating over your editor.
    /// </summary>
    private async void OnNavigationCompleted(object? s, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess)
        {
            _loadAttempts = 0;
            // The mode is posted only when it CHANGES, so a decision made while
            // the page was still loading reached nobody - its listener did not
            // exist yet, and the host would never mention it again. Re-state it
            // on every successful load (a reload included).
            _compactSent = null;
            return;
        }
        if (++_loadAttempts > 60) return; // ~2 minutes, then stop trying
        await Task.Delay(2000);
        Web.CoreWebView2?.Navigate(_url);
    }

    /// <summary>Messages from the page. Mirrors HostMessage in web/src/lib/nativeHost.ts.</summary>
    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonElement msg;
        try
        {
            msg = JsonDocument.Parse(e.WebMessageAsJson).RootElement;
        }
        catch (JsonException)
        {
            return; // not ours
        }
        if (msg.ValueKind != JsonValueKind.Object) return;
        if (!msg.TryGetProperty("cmd", out var cmdProp)) return;

        switch (cmdProp.GetString())
        {
            case "resize":
                if (msg.TryGetProperty("h", out var h)) FitHeight(h.GetDouble());
                break;
            case "compactWidth":
                if (msg.TryGetProperty("w", out var cw)) SetCompactWidth(cw.GetDouble());
                break;
            case "config":
                if (msg.TryGetProperty("autoCompact", out var a))
                    SetAutoCompact(a.ValueKind == JsonValueKind.True);
                break;
            case "raiseHelm":
                RaiseHelm();
                break;
            case "close":
                Close();
                break;
        }
    }

    /// <summary>
    /// Hug the page's content vertically. This is what makes click-through
    /// unnecessary: the window IS the notch, so everything around it is already
    /// the app underneath.
    ///
    /// HEIGHT ONLY, on purpose. Taking WIDTH from the page as well was a
    /// feedback loop — resizing the window reflowed the content, which changed
    /// the measured width, which resized the window again; it settled into an
    /// oscillation between two widths and, because this method used to re-centre
    /// the window after every change, that showed up as the whole notch shaking
    /// sideways on screen. The window's width is its own; the page adapts to it.
    /// </summary>
    private void FitHeight(double h)
    {
        if (h < 12) return;
        var wanted = Math.Min(h, SystemParameters.PrimaryScreenHeight);
        if (Math.Abs(wanted - _targetHeight) < 2) return; // ignore sub-pixel churn
        _targetHeight = wanted;
        StartSlide();
    }

    // How deeply the bottom corners curve, in device-independent pixels. A
    // PANEL corner, not a sweep: 55 read as "too angled" against the reference,
    // and an aggressive curve also eats into the last row's text. ApplyShape
    // clamps it to half the window, so the short compact strip stays sensible.
    // Keep in step with the border-radius in styles.css (.hud-page.notch .hud).
    private const double BottomRadiusDip = 14;

    // ---- getting out of the way ---------------------------------------------
    // The notch is for when Helm is NOT in front of you, so it hides itself
    // whenever Helm's window is on screen and reappears the moment that window
    // is minimised or closed. Not a setting: it used to be one, and the owner's
    // copy ended up with it switched off, which read as "the notch never hides".
    // It also hides while the foreground app is FULL SCREEN (a video, a game, a
    // presentation) - the notch is a topmost window, so without this it would
    // sit over all of them. Watching from here rather than having the server
    // push events keeps it to a couple of Win32 calls and survives the server
    // restarting underneath.
    private System.Windows.Threading.DispatcherTimer? _watch;
    private bool _autoCompact = true;

    // At rest the notch does not go away - it shrinks to a strip of status
    // lights (NotchStrip), which is the point of a notch: a glance tells you
    // whether anything wants you. Reaching it with the cursor expands it to the
    // full list, the way an auto-hidden taskbar slides back.
    // The compact strip's width. Fixed values, but not ONE value: it is wider
    // when it has to name a project ("storefront ! Needs you") than when it is
    // just lights. The page picks from a couple of constants by state, so this
    // never becomes the measure-reflow-measure loop that once made it shake.
    private double _compactWidth = 200;
    private const double ExpandedWidthDip = 460;
    private const int EdgeTriggerPx = 3; // how close to the top edge counts as a reach
    private const int HoverSlackPx = 10; // slack around the window before it shrinks
    private const int LeaveTicks = 5; // ~500ms of "cursor is elsewhere" before shrinking
    private bool _revealed = true;
    private int _leaveTicks;
    private int _helmTick;
    private bool _helmUp;
    private bool _fullScreen;
    private bool? _compactSent; // null = the page has not been told yet
    private System.Windows.Threading.DispatcherTimer? _slide;
    private const double AnimMs = 160; // long enough to read as motion, short enough to feel instant
    private double _targetWidth = ExpandedWidthDip;
    private double _targetHeight = 180;
    private double _curW,
        _curH,
        _fromW,
        _fromH;
    private DateTime _animStart;
    private int _lastW = -1,
        _lastH = -1,
        _lastLeft = -1;

    private void SetAutoCompact(bool autoCompact)
    {
        if (_autoCompact == autoCompact) return;
        _autoCompact = autoCompact;
        if (!_autoCompact) _revealed = true; // pinned open
        UpdateVisibility();
    }

    // One timer, ticking fast enough for hover to feel immediate. The Helm-window
    // scan is the expensive half (it enumerates every top-level window), so it
    // and the full-screen check only run every sixth tick.
    private void StartWatching()
    {
        _watch = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(100),
        };
        _watch.Tick += (_, _) => UpdateVisibility();
        _watch.Start();
    }

    private void UpdateVisibility()
    {
        if (_helmTick-- <= 0)
        {
            _helmTick = 5;
            _helmUp = HelmWindowOnScreen();
            _fullScreen = ForegroundIsFullScreen();
        }
        Trace(); // before the early return, so the log says WHY it is hidden

        // Getting out of the way wins: while Helm itself is in front of you, or
        // something is running full screen, the notch is not wanted at all, so
        // it goes away entirely rather than sitting there as a strip. It comes
        // back in whichever face the settings call for.
        if (_helmUp || _fullScreen)
        {
            if (Visibility != Visibility.Hidden) Visibility = Visibility.Hidden;
            _revealed = !_autoCompact;
            return;
        }
        if (Visibility != Visibility.Visible) Visibility = Visibility.Visible;

        if (_autoCompact)
        {
            if (CursorWantsIt())
            {
                _revealed = true;
                _leaveTicks = 0;
            }
            else if (_revealed && ++_leaveTicks >= LeaveTicks)
            {
                _revealed = false;
            }
        }

        SetCompact(!_revealed);
    }

    /// <summary>
    /// Tell the page which face to show, and size the window for it. The page
    /// reports its own HEIGHT back (see FitHeight); WIDTH is set from the mode
    /// alone and never measured - measuring width is what once made the whole
    /// notch oscillate on screen, and a fixed compact width also stops the strip
    /// resizing itself every time a pane appears or a status changes.
    /// </summary>
    private void SetCompact(bool compact)
    {
        if (_compactSent != compact)
        {
            _compactSent = compact;
            Web.CoreWebView2?.PostWebMessageAsJson(
                compact ? COMPACT_ON : COMPACT_OFF
            );
        }
        var wanted = compact ? _compactWidth : ExpandedWidthDip;
        if (Math.Abs(_targetWidth - wanted) < 0.5) return;
        _targetWidth = wanted;
        StartSlide();
    }

    /// <summary>
    /// The compact strip changed face (something now needs you, or no longer
    /// does) and wants a different width. Applied immediately when the notch is
    /// already resting, so the alert widens in place rather than waiting for
    /// the next hover.
    /// </summary>
    private void SetCompactWidth(double w)
    {
        if (w < 80 || w > ExpandedWidthDip) return; // ignore nonsense
        if (Math.Abs(_compactWidth - w) < 0.5) return;
        _compactWidth = w;
        if (_compactSent == true) SetCompact(true);
    }

    private const string COMPACT_ON = "{\"compact\":true}";
    private const string COMPACT_OFF = "{\"compact\":false}";

    /// <summary>
    /// Should the notch be on screen? Parked, that means the cursor reaching the
    /// top edge within its width (the taskbar's trigger). Revealed, it means the
    /// cursor being anywhere on it, plus a little slack so a shaky hand on the
    /// way to a button doesn't dismiss it.
    /// </summary>
    // HELMNOTCH_LOG=<file> dumps one line per tick. Off unless asked for; the
    // only way to see why the window decided what it decided.
    private static readonly string? TraceFile = Environment.GetEnvironmentVariable("HELMNOTCH_LOG");

    private void Trace()
    {
        if (TraceFile is null) return;
        GetCursorPos(out var p);
        var hwnd = new WindowInteropHelper(this).Handle;
        GetWindowRect(hwnd, out var r);
        try
        {
            System.IO.File.AppendAllText(
                TraceFile,
                $"cursor={p.X},{p.Y} rect={r.Left},{r.Top},{r.Right},{r.Bottom} vis={Visibility} "
                    + $"revealed={_revealed} leave={_leaveTicks} autoCompact={_autoCompact} "
                    + $"helmUp={_helmUp} fullScreen={_fullScreen} wants={CursorWantsIt()} "
                    + $"W={Width:F0} H={Height:F0} tW={_targetWidth:F0} tH={_targetHeight:F0}"
                    + Environment.NewLine
            );
        }
        catch
        {
            /* diagnostics must never take the window down */
        }
    }

    private bool CursorWantsIt()
    {
        if (!GetCursorPos(out var p)) return false;
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero || !GetWindowRect(hwnd, out var r)) return false;
        if (p.X < r.Left - HoverSlackPx || p.X > r.Right + HoverSlackPx) return false;
        // Expanded, anywhere on it counts (plus slack, so a shaky hand on the way
        // to a button does not collapse it). Compact, the strip itself is only a
        // couple of dozen pixels tall, so its own height IS the trigger zone.
        if (_revealed) return p.Y <= r.Bottom + HoverSlackPx;
        return p.Y <= Math.Max(EdgeTriggerPx, r.Bottom);
    }

    /// <summary>
    /// Ease the window toward its target size instead of snapping, so switching
    /// between the strip and the full list reads as one shape growing. It stays
    /// pinned to the top edge and horizontally centred throughout. Retargetable
    /// mid-flight: reaching for it while it is still shrinking reverses the
    /// animation rather than queueing behind it.
    /// </summary>
    private void StartSlide()
    {
        if (_slide is null)
        {
            _curW = Width;
            _curH = Height;
        }
        _fromW = _curW;
        _fromH = _curH;
        _animStart = DateTime.UtcNow;
        _slide ??= BuildSlideTimer();
        if (!_slide.IsEnabled) _slide.Start();
    }

    /// <summary>
    /// TIME-based, not proportional-step. The first version moved a fraction of
    /// the remaining distance each tick, which never really converges: it ran a
    /// long tail of sub-pixel frames, each one repainting and re-cutting the
    /// region, and the owner saw that as jitter. This runs for a fixed duration
    /// and lands exactly.
    /// </summary>
    private System.Windows.Threading.DispatcherTimer BuildSlideTimer()
    {
        var t = new System.Windows.Threading.DispatcherTimer
        {
            Interval = TimeSpan.FromMilliseconds(16),
        };
        t.Tick += (_, _) =>
        {
            var elapsed = (DateTime.UtcNow - _animStart).TotalMilliseconds;
            var k = Math.Min(1.0, elapsed / AnimMs);
            var eased = 1 - Math.Pow(1 - k, 3); // easeOutCubic
            _curW = _fromW + (_targetWidth - _fromW) * eased;
            _curH = _fromH + (_targetHeight - _fromH) * eased;
            if (k >= 1)
            {
                _curW = _targetWidth;
                _curH = _targetHeight;
                t.Stop();
            }
            PushFrame();
        };
        return t;
    }

    /// <summary>
    /// Move and resize in ONE SetWindowPos call, on whole pixels.
    ///
    /// Setting WPF's Left, Width and Height separately issues a window
    /// reposition per property, so a single animation frame moved the window
    /// two or three times - visible as wobble. Fractional sizes made it worse:
    /// each frame landed on a different sub-pixel rounding. Snapping to integer
    /// physical pixels and pushing one call per frame removes both, and the
    /// region is only re-cut when the size actually changed.
    /// </summary>
    private void PushFrame()
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        if (hwnd == IntPtr.Zero) return;
        var dpi = VisualTreeHelper.GetDpi(this);
        int w = (int)Math.Round(_curW * dpi.DpiScaleX);
        int h = (int)Math.Round(_curH * dpi.DpiScaleY);
        int screenW = (int)Math.Round(SystemParameters.PrimaryScreenWidth * dpi.DpiScaleX);
        int left = (screenW - w) / 2;
        if (w == _lastW && h == _lastH && left == _lastLeft) return;
        _lastW = w;
        _lastH = h;
        _lastLeft = left;
        SetWindowPos(hwnd, IntPtr.Zero, left, 0, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
        ApplyShape(); // the curve is cut to a pixel size, so re-cut when it changes
    }

    /// <summary>
    /// Helm's own window, minimised or not. Matched by TITLE, because the
    /// browser app window is hosted by an already-running browser process, so a
    /// command line tells you nothing (GOTCHAS). Helm's page title always
    /// CONTAINS "Helm ⎈": the app window's title is exactly that (with a
    /// varying "(2 waiting)" prefix), and a Helm TAB in an ordinary browser
    /// window puts it in front of " - Microsoft Edge". Contains rather than
    /// ends-with so that second case counts as Helm being open too; the ⎈ is
    /// what keeps an editor that merely mentions helm from matching. Prefers
    /// one that is actually on screen when there are several.
    /// </summary>
    private static IntPtr FindHelmWindow()
    {
        IntPtr onScreen = IntPtr.Zero;
        IntPtr minimised = IntPtr.Zero;
        EnumWindows(
            (hwnd, _) =>
            {
                if (!IsWindowVisible(hwnd)) return true;
                int len = GetWindowTextLength(hwnd);
                if (len < HelmTitleMark.Length) return true;
                var sb = new StringBuilder(len + 1);
                GetWindowText(hwnd, sb, sb.Capacity);
                if (!sb.ToString().Contains(HelmTitleMark, StringComparison.Ordinal)) return true;
                if (IsIconic(hwnd))
                {
                    if (minimised == IntPtr.Zero) minimised = hwnd;
                    return true; // keep looking for one that is actually up
                }
                onScreen = hwnd;
                return false;
            },
            IntPtr.Zero
        );
        return onScreen != IntPtr.Zero ? onScreen : minimised;
    }

    private static bool HelmWindowOnScreen()
    {
        var hwnd = FindHelmWindow();
        return hwnd != IntPtr.Zero && !IsIconic(hwnd);
    }

    /// <summary>
    /// Is the app in front full screen on the notch's monitor? The same test
    /// Windows' own Focus Assist uses for "when I'm using an app in full-screen
    /// mode": the foreground window's rect covers the whole monitor. A MAXIMISED
    /// window is excluded on purpose - with an auto-hidden taskbar it covers the
    /// monitor too, and an ordinary maximised editor is exactly what the notch
    /// is meant to float over. So is the desktop itself (Progman/WorkerW cover
    /// the screen by definition) and the notch, which is topmost and would
    /// otherwise hide itself the moment it was clicked.
    /// </summary>
    private bool ForegroundIsFullScreen()
    {
        var fg = GetForegroundWindow();
        var self = new WindowInteropHelper(this).Handle;
        if (fg == IntPtr.Zero || fg == self) return false;
        if (IsIconic(fg) || IsZoomed(fg)) return false;
        var cls = new StringBuilder(64);
        GetClassName(fg, cls, cls.Capacity);
        var name = cls.ToString();
        if (name == "Progman" || name == "WorkerW") return false;
        if (!GetWindowRect(fg, out var r)) return false;
        var mon = MonitorFromWindow(self, MONITOR_DEFAULTTOPRIMARY);
        if (mon != MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST)) return false;
        var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
        if (!GetMonitorInfo(mon, ref info)) return false;
        var m = info.rcMonitor;
        return r.Left <= m.Left && r.Top <= m.Top && r.Right >= m.Right && r.Bottom >= m.Bottom;
    }

    /// <summary>
    /// Bring Helm's window to the front, restoring it if it was minimised.
    ///
    /// This has to happen HERE rather than in the page: the page's own
    /// window.focus() is a web page asking politely, which browsers ignore for a
    /// minimised or background window - so clicking an agent selected the right
    /// pane inside a Helm that stayed hidden, which is exactly the case the
    /// notch exists for. A native process can just do it. Windows only grants
    /// foreground rights to a process with recent input, and the user has just
    /// clicked the notch, so this is that process.
    /// </summary>
    private void RaiseHelm()
    {
        var hwnd = FindHelmWindow();
        var wasIconic = hwnd != IntPtr.Zero && IsIconic(hwnd);
        var restored = wasIconic && ShowWindow(hwnd, SW_RESTORE);
        var fg = hwnd != IntPtr.Zero && SetForegroundWindow(hwnd);
        Log($"raiseHelm hwnd={hwnd} wasIconic={wasIconic} restored={restored} setFg={fg}");
    }

    private static void Log(string line)
    {
        if (TraceFile is null) return;
        try
        {
            System.IO.File.AppendAllText(TraceFile, line + Environment.NewLine);
        }
        catch
        {
            /* diagnostics must never take the window down */
        }
    }

    private const string HelmTitleMark = "Helm ⎈";

    private void PlaceAtTopCentre()
    {
        Left = (SystemParameters.PrimaryScreenWidth - Width) / 2;
        Top = 0; // flush with the top edge - the notch hangs FROM the screen
    }


    private const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
    private const int DWMWCP_DONOTROUND = 1;
    private const int RGN_OR = 2;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left,
            Top,
            Right,
            Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateRoundRectRgn(int l, int t, int r, int b, int ew, int eh);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateRectRgn(int l, int t, int r, int b);

    [DllImport("gdi32.dll")]
    private static extern int CombineRgn(IntPtr dst, IntPtr a, IntPtr b, int mode);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr obj);

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);

    private const uint MONITOR_DEFAULTTOPRIMARY = 1;
    private const uint MONITOR_DEFAULTTONEAREST = 2;

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X,
            Y;
    }

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT p);

    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;

    private const int SW_RESTORE = 9;

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int cmd);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr after,
        int x,
        int y,
        int cx,
        int cy,
        uint flags
    );
}
