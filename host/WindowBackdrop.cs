using System.Runtime.InteropServices;

namespace DesktopMusicFloat;

internal static class WindowBackdrop
{
    private const int SystemBackdrop = 38;
    private const int BackdropNone = 1;
    private const int CornerPreference = 33;
    private const int CornerDoNotRound = 1;
    private const int BorderColor = 34;
    private const int ColorNone = unchecked((int)0xFFFFFFFE);

    internal static void Disable(IntPtr window)
    {
        Set(window, SystemBackdrop, BackdropNone);
        Set(window, CornerPreference, CornerDoNotRound);
        Set(window, BorderColor, ColorNone);
    }

    internal static void ClearOverrides(IntPtr window)
    {
        // A window theme tool can change these attributes after the window is shown.
        if (DwmGetWindowAttribute(window, SystemBackdrop, out int backdrop, sizeof(int)) == 0 &&
            backdrop != BackdropNone)
            Disable(window);
    }

    private static void Set(IntPtr window, int attribute, int value)
    {
        DwmSetWindowAttribute(window, attribute, ref value, sizeof(int));
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
}
