using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Win32;
using Pointer = System.Windows.Forms.Cursor;
using Wpf = System.Windows;

namespace DesktopMusicFloat;

internal sealed class FloatingWindow : Wpf.Window, IDisposable
{
    private const int WindowWidth = 500;
    private const int CardHeight = 200;
    private const int LyricsHeight = 152;
    private const int RestoreHotkeyId = 1;
    private const string RestoreShortcut = "Ctrl+Alt+Shift+P";
    private const string WebUrl = "https://desktop-music-float.local/index.html";
    private readonly PlayerBridge bridge;
    private readonly string directory;
    private readonly string settingsPath;
    private readonly WindowSettings settings;
    private readonly WebView2CompositionControl web = new() { DefaultBackgroundColor = Color.Transparent };
    private readonly OverlaySurface surface;
    private readonly EdgeTab edgeTab = new();
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 45 };
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem topItem = new("置顶");
    private readonly ToolStripMenuItem clickItem = new("点击穿透");
    private readonly ToolStripMenuItem dockItem = new("吸附隐藏");
    private readonly ToolStripMenuItem lyricsAlignmentItem = new("歌词对齐");
    private bool ready, closing, initializing, lyricsBelow, lyricsLeft;
    private bool pointerVisited, pointerOutside, pointerExitSent;
    private HwndSource? hotkeySource;
    private Point? dragOffset;
    private long outsideSince, suppressHideUntil, nextBackdropCheck;
    private IntPtr handle;

    private Rectangle Bounds
    {
        get
        {
            if (handle == IntPtr.Zero || !GetWindowRect(handle, out var rect)) return Rectangle.Empty;
            return Rectangle.FromLTRB(rect.Left, rect.Top, rect.Right, rect.Bottom);
        }
    }

    private Rectangle CardBounds
    {
        get
        {
            var origin = Bounds.Location;
            if (!lyricsBelow) origin.Offset(0, ScalePixel(LyricsHeight));
            return new Rectangle(origin, CardSize);
        }
    }

    internal FloatingWindow(string directory, PlayerBridge bridge)
    {
        this.directory = directory;
        this.bridge = bridge;
        settingsPath = Path.Combine(directory, "window.json");
        settings = WindowSettings.Load(settingsPath);
        if (settings.ClickThrough)
        {
            settings.ClickThrough = false;
            settings.Save(settingsPath);
        }
        if (!settings.AutoHide) settings.Edge = DockEdge.None;
        Title = "网易云桌面音乐悬浮窗";
        WindowStyle = Wpf.WindowStyle.None;
        ResizeMode = Wpf.ResizeMode.NoResize;
        AllowsTransparency = true;
        Background = Wpf.Media.Brushes.Transparent;
        ShowInTaskbar = false;
        ShowActivated = false;
        WindowStartupLocation = Wpf.WindowStartupLocation.Manual;
        Width = WindowWidth;
        Height = CardHeight + LyricsHeight;
        surface = new OverlaySurface(web);
        Content = surface;

        var menu = new ContextMenuStrip();
        menu.Items.Add("显示悬浮窗", null, (_, _) => Reveal());
        menu.Items.Add("隐藏悬浮窗", null, (_, _) => HideManually());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.AddRange([dockItem, topItem, clickItem, lyricsAlignmentItem]);
        foreach (var (label, alignment) in new[] {
            ("自动（随位置）", LyricsAlignment.Auto), ("左对齐", LyricsAlignment.Left), ("右对齐", LyricsAlignment.Right)
        })
        {
            var choice = new ToolStripMenuItem(label) { Tag = alignment };
            choice.Click += (_, _) => SelectLyricsAlignment(alignment);
            lyricsAlignmentItem.DropDownItems.Add(choice);
        }
        dockItem.Click += (_, _) => Toggle("dock");
        topItem.Click += (_, _) => Toggle("top");
        clickItem.Click += (_, _) => Toggle("through");
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = Title, ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += (_, _) => Reveal();
        edgeTab.MouseEnter += (_, _) => Reveal();
        edgeTab.Click += (_, _) => Reveal();

        bridge.Message += Receive;
        SystemEvents.DisplaySettingsChanged += DisplayChanged;
        timer.Tick += (_, _) => PollPointer();
        AddHandler(Wpf.Input.Mouse.PreviewMouseMoveEvent,
            new Wpf.Input.MouseEventHandler((_, _) => pointerVisited = true), true);
        SourceInitialized += (_, _) =>
        {
            handle = new WindowInteropHelper(this).Handle;
            WindowBackdrop.Disable(handle);
            RegisterRestoreShortcut();
            RestorePosition();
            ApplyFlags();
            timer.Start();
            suppressHideUntil = Environment.TickCount64 + 1700;
        };
        IsVisibleChanged += (_, _) =>
        {
            if (!IsVisible || handle == IntPtr.Zero) return;
            WindowBackdrop.Disable(handle);
            nextBackdropCheck = Environment.TickCount64 + 120;
        };
        DpiChanged += (_, _) =>
        {
            if (dragOffset is null && !closing)
                Dispatcher.InvokeAsync(() => Place(Normalized(CardBounds.Location), settings.Edge));
        };
        Loaded += async (_, _) =>
        {
            if (initializing) return;
            initializing = true;
            await InitializeWebAsync();
        };
    }

    private async Task InitializeWebAsync()
    {
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(
                userDataFolder: Path.Combine(directory, "web-profile"));
            if (closing) return;
            await web.EnsureCoreWebView2Async(environment);
            if (closing) return;
            var core = web.CoreWebView2;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.SetVirtualHostNameToFolderMapping("desktop-music-float.local",
                Path.Combine(AppContext.BaseDirectory, "web"), CoreWebView2HostResourceAccessKind.Deny);
            core.NavigationStarting += (_, eventArgs) => eventArgs.Cancel = eventArgs.Uri != WebUrl;
            core.NewWindowRequested += (_, eventArgs) => eventArgs.Handled = true;
            core.WebMessageReceived += WebMessage;
            core.Navigate(WebUrl);
        }
        catch (Exception error)
        {
            if (closing) return;
            File.WriteAllText(Path.Combine(directory, "startup-error.txt"), error.ToString());
            Content = new Wpf.Controls.TextBlock {
                Text = "无法打开音乐悬浮窗。请检查 Microsoft Edge WebView2 Runtime。",
                Foreground = Wpf.Media.Brushes.White, Background = Wpf.Media.Brushes.Black,
                TextAlignment = Wpf.TextAlignment.Center, VerticalAlignment = Wpf.VerticalAlignment.Center
            };
        }
    }

    private async void WebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (args.Source != WebUrl || closing) return;
        using var document = JsonDocument.Parse(args.WebMessageAsJson);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var type) ||
            type.ValueKind != JsonValueKind.String) return;
        switch (type.GetString())
        {
            case "ready":
                ready = true;
                PostSettings();
                await bridge.SendCommandAsync("sync");
                break;
            case "drag":
                if (!settings.ClickThrough && (Control.MouseButtons & MouseButtons.Left) != 0)
                {
                    var bounds = CardBounds;
                    dragOffset = new Point(Pointer.Position.X - bounds.Left, Pointer.Position.Y - bounds.Top);
                    settings.Edge = DockEdge.None;
                }
                break;
            case "surface":
                surface.Apply(root);
                break;
            case "option":
                if (root.TryGetProperty("action", out var option) && option.ValueKind == JsonValueKind.String)
                    Toggle(option.GetString()!);
                break;
            case "playback":
                if (settings.ClickThrough || !root.TryGetProperty("action", out var action) ||
                    action.ValueKind != JsonValueKind.String) break;
                switch (action.GetString())
                {
                    case "previous":
                    case "toggle":
                    case "next":
                        await bridge.SendCommandAsync(action.GetString()!);
                        break;
                    case "seek":
                        if (root.TryGetProperty("ratio", out var ratio) && ratio.ValueKind == JsonValueKind.Number &&
                            ratio.TryGetDouble(out double fraction) && fraction is >= 0 and <= 1 &&
                            root.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String)
                            await bridge.SendCommandAsync("seek", id.GetString(), fraction);
                        break;
                    case "volume":
                        if (root.TryGetProperty("level", out var level) && level.ValueKind == JsonValueKind.Number &&
                            level.TryGetDouble(out double volume) && volume is >= 0 and <= 1)
                            await bridge.SendCommandAsync("volume", ratio: volume);
                        break;
                }
                break;
        }
    }

    private void Receive(string message)
    {
        if (closing || handle == IntPtr.Zero) return;
        try
        {
            Dispatcher.InvokeAsync(() =>
            {
                if (closing) return;
                using var document = JsonDocument.Parse(message);
                switch (document.RootElement.GetProperty("type").GetString())
                {
                    case "show": Reveal(); break;
                    case "restore-interaction": RestoreInteraction(); break;
                    case "quit": Close(); break;
                    default:
                        if (ready) web.CoreWebView2?.PostWebMessageAsJson(message);
                        break;
                }
            });
        }
        catch (InvalidOperationException) { }
    }

    private void Toggle(string option)
    {
        switch (option)
        {
            case "top": settings.AlwaysOnTop = !settings.AlwaysOnTop; break;
            case "through":
                if (settings.ClickThrough)
                {
                    RestoreInteraction();
                    return;
                }
                settings.ClickThrough = true;
                break;
            case "dock":
                settings.AutoHide = !settings.AutoHide;
                settings.Edge = settings.AutoHide ? NearestEdge(CardBounds, int.MaxValue) : DockEdge.None;
                Reveal();
                break;
            default: return;
        }
        ApplyFlags();
        SavePosition();
        PostSettings();
        if (option == "through")
        {
            string hint = hotkeySource is null
                ? "在网易云的插件设置中点击「恢复鼠标操作」，或从托盘关闭穿透。"
                : $"按 {RestoreShortcut} 恢复鼠标操作，也可在网易云插件设置中恢复。";
            tray.ShowBalloonTip(3500, "已开启点击穿透", hint, ToolTipIcon.Info);
        }
    }

    private void RestoreInteraction()
    {
        if (settings.ClickThrough)
        {
            settings.ClickThrough = false;
            ApplyFlags();
            SavePosition();
            PostSettings();
        }
        Reveal();
    }

    private void RegisterRestoreShortcut()
    {
        var source = HwndSource.FromHwnd(handle);
        const uint alt = 0x1, control = 0x2, shift = 0x4, noRepeat = 0x4000;
        if (source is null || !RegisterHotKey(handle, RestoreHotkeyId, alt | control | shift | noRepeat, 'P')) return;
        hotkeySource = source;
        source.AddHook(OnHotkey);
    }

    private IntPtr OnHotkey(IntPtr window, int message, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        const int wmHotkey = 0x0312;
        if (message == wmHotkey && wParam.ToInt32() == RestoreHotkeyId)
        {
            handled = true;
            RestoreInteraction();
        }
        return IntPtr.Zero;
    }

    private void PostSettings()
    {
        if (ready) web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new {
            type = "options", top = settings.AlwaysOnTop, through = settings.ClickThrough, dock = settings.AutoHide,
            lyricsBelow, lyricsLeft, restoreShortcut = hotkeySource is null ? null : RestoreShortcut
        }));
    }

    private void SelectLyricsAlignment(LyricsAlignment alignment)
    {
        settings.LyricsAlignment = alignment;
        var card = CardBounds;
        lyricsLeft = AlignLyricsLeft(card, Screen.FromRectangle(card).WorkingArea);
        ApplyFlags();
        settings.Save(settingsPath);
        PostSettings();
    }

    private bool AlignLyricsLeft(Rectangle card, Rectangle area) => settings.LyricsAlignment switch {
        LyricsAlignment.Left => true,
        LyricsAlignment.Right => false,
        _ => card.Left - area.Left < area.Right - card.Right
    };

    private void ApplyFlags()
    {
        Topmost = settings.AlwaysOnTop;
        edgeTab.TopMost = settings.AlwaysOnTop;
        topItem.Checked = settings.AlwaysOnTop;
        clickItem.Checked = settings.ClickThrough;
        clickItem.Text = settings.ClickThrough ? "关闭点击穿透" : "开启点击穿透";
        clickItem.ShortcutKeyDisplayString = settings.ClickThrough && hotkeySource is not null ? RestoreShortcut : "";
        dockItem.Checked = settings.AutoHide;
        foreach (ToolStripMenuItem choice in lyricsAlignmentItem.DropDownItems)
            choice.Checked = Equals(choice.Tag, settings.LyricsAlignment);
        SetClickThrough();
    }

    private void SetClickThrough()
    {
        if (handle == IntPtr.Zero) return;
        const int extendedStyle = -20, transparent = 0x20;
        int style = GetWindowLong(handle, extendedStyle);
        int updated = settings.ClickThrough ? style | transparent : style & ~transparent;
        if (updated == style) return;
        SetWindowLong(handle, extendedStyle, updated);
    }

    private int ScalePixel(int value) => (int)Math.Round(value * Math.Max(96, (int)GetDpiForWindow(handle)) / 96.0);
    private Size CardSize => new(ScalePixel(WindowWidth), ScalePixel(CardHeight));
    private Size WindowSize => new(ScalePixel(WindowWidth), ScalePixel(CardHeight + LyricsHeight));

    private Point Normalized(Point origin)
    {
        var area = Screen.FromRectangle(new Rectangle(origin, CardSize)).WorkingArea;
        return new Point(Math.Clamp(origin.X, area.Left, Math.Max(area.Left, area.Right - CardSize.Width)),
            Math.Clamp(origin.Y, area.Top, Math.Max(area.Top, area.Bottom - CardSize.Height)));
    }

    private void RestorePosition()
    {
        var area = Screen.PrimaryScreen!.WorkingArea;
        var fallback = new Point(area.Right - CardSize.Width - ScalePixel(28), area.Bottom - CardSize.Height - ScalePixel(30));
        var origin = settings.X is int x && settings.Y is int y ? new Point(x, y) : fallback;
        Place(Normalized(origin), settings.Edge);
    }

    private void Place(Point origin, DockEdge edge)
    {
        Size size = CardSize;
        var area = Screen.FromRectangle(new Rectangle(origin, size)).WorkingArea;
        origin = edge switch {
            DockEdge.Left => new Point(area.Left, origin.Y),
            DockEdge.Right => new Point(area.Right - size.Width, origin.Y),
            DockEdge.Top => new Point(origin.X, area.Top),
            DockEdge.Bottom => new Point(origin.X, area.Bottom - size.Height),
            _ => origin
        };
        int availableAbove = origin.Y - area.Top;
        int availableBelow = area.Bottom - origin.Y - size.Height;
        bool below = availableAbove < ScalePixel(LyricsHeight) && availableBelow > availableAbove;
        bool left = AlignLyricsLeft(new Rectangle(origin, size), area);
        bool changed = below != lyricsBelow || left != lyricsLeft;
        lyricsBelow = below;
        lyricsLeft = left;
        MoveCard(origin);
        if (changed) PostSettings();
    }

    private void MoveCard(Point origin)
    {
        const uint noZOrder = 0x0004, noActivate = 0x0010;
        if (!lyricsBelow) origin.Offset(0, -ScalePixel(LyricsHeight));
        Size size = WindowSize;
        SetWindowPos(handle, IntPtr.Zero, origin.X, origin.Y, size.Width, size.Height, noZOrder | noActivate);
    }

    private static DockEdge NearestEdge(Rectangle bounds, int threshold)
    {
        var area = Screen.FromRectangle(bounds).WorkingArea;
        var candidates = new[] {
            (DockEdge.Left, Math.Abs(bounds.Left - area.Left)), (DockEdge.Right, Math.Abs(bounds.Right - area.Right)),
            (DockEdge.Top, Math.Abs(bounds.Top - area.Top)), (DockEdge.Bottom, Math.Abs(bounds.Bottom - area.Bottom))
        };
        var (edge, distance) = candidates.MinBy(candidate => candidate.Item2);
        return distance <= threshold ? edge : DockEdge.None;
    }

    private void SavePosition()
    {
        var bounds = CardBounds;
        settings.X = bounds.Left;
        settings.Y = bounds.Top;
        settings.Save(settingsPath);
    }

    private void CheckPointerTransition(Point pointer)
    {
        if (!ready || !pointerVisited || settings.ClickThrough) return;

        // Composition WebView can miss transitions across a transparent window region.
        if (Bounds.Contains(pointer) && surface.Contains(pointer))
        {
            if (pointerOutside)
            {
                pointerOutside = pointerExitSent = false;
                var point = surface.PointInWeb(pointer);
                web.CoreWebView2?.PostWebMessageAsJson(JsonSerializer.Serialize(new {
                    type = "pointer-return", x = point.X, y = point.Y
                }));
            }
            return;
        }
        if (pointerExitSent) return;
        // Allow the clip to settle when the pointer moves into the volume popup.
        if ((Control.MouseButtons & MouseButtons.Left) != 0)
        {
            pointerOutside = false;
            return;
        }
        if (!pointerOutside)
        {
            pointerOutside = true;
            return;
        }
        pointerExitSent = true;
        web.CoreWebView2?.PostWebMessageAsJson("{\"type\":\"pointer-exit\"}");
    }

    private void PollPointer()
    {
        long now = Environment.TickCount64;
        if (bridge.IdleMilliseconds > (bridge.HasConnected ? 12000 : 35000))
        {
            Close();
            return;
        }
        if (!IsVisible) return;
        if (now >= nextBackdropCheck)
        {
            WindowBackdrop.ClearOverrides(handle);
            nextBackdropCheck = now + 1000;
        }
        var bounds = CardBounds;
        var pointer = Pointer.Position;
        CheckPointerTransition(pointer);
        if (dragOffset is Point offset)
        {
            if ((Control.MouseButtons & MouseButtons.Left) != 0)
            {
                MoveCard(new Point(pointer.X - offset.X, pointer.Y - offset.Y));
                return;
            }
            dragOffset = null;
            var origin = Normalized(bounds.Location);
            settings.Edge = settings.AutoHide ? NearestEdge(new Rectangle(origin, CardSize), ScalePixel(28)) : DockEdge.None;
            Place(origin, settings.Edge);
            bounds = CardBounds;
            SavePosition();
            suppressHideUntil = now + 700;
        }
        if (settings.Edge == DockEdge.None || now < suppressHideUntil || bounds.Contains(pointer) ||
            (Bounds.Contains(pointer) && surface.Contains(pointer)))
        {
            outsideSince = 0;
            return;
        }
        if (outsideSince == 0) outsideSince = now;
        if (now - outsideSince >= 700)
        {
            var area = Screen.FromRectangle(bounds).WorkingArea;
            edgeTab.DockTo(settings.Edge, area, bounds, ScalePixel(8), ScalePixel(64));
            Hide();
            edgeTab.Show();
        }
    }

    private void Reveal()
    {
        edgeTab.Hide();
        Place(Normalized(CardBounds.Location), settings.Edge);
        if (!IsVisible) Show();
        outsideSince = 0;
        suppressHideUntil = Environment.TickCount64 + 950;
    }

    private void HideManually()
    {
        edgeTab.Hide();
        Hide();
    }

    private void DisplayChanged(object? sender, EventArgs e)
    {
        if (closing || handle == IntPtr.Zero) return;
        Dispatcher.InvokeAsync(() =>
        {
            if (edgeTab.Visible) Reveal();
            else Place(Normalized(CardBounds.Location), settings.Edge);
        });
    }

    protected override void OnClosed(EventArgs e)
    {
        Dispose();
        base.OnClosed(e);
    }

    public void Dispose()
    {
        if (closing) return;
        closing = true;
        bridge.Message -= Receive;
        SystemEvents.DisplaySettingsChanged -= DisplayChanged;
        if (hotkeySource is not null)
        {
            UnregisterHotKey(handle, RestoreHotkeyId);
            hotkeySource.RemoveHook(OnHotkey);
        }
        timer.Dispose();
        edgeTab.Dispose();
        tray.Visible = false;
        tray.ContextMenuStrip?.Dispose();
        tray.Dispose();
        web.Dispose();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRectangle { internal int Left, Top, Right, Bottom; }

    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")]
    private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr window, int id);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongW")]
    private static extern int SetWindowLong(IntPtr window, int index, int value);
    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out NativeRectangle bounds);
    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
}
