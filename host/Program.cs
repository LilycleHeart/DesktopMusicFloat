using System.Security.Cryptography;
using System.Text;

namespace DesktopMusicFloat;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        if (args.Length != 1) return;
        string decoded = Uri.UnescapeDataString(args[0]);
        if (!Path.IsPathFullyQualified(decoded)) return;
        string directory = Path.GetFullPath(decoded);
        Directory.CreateDirectory(directory);
        string instance = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(directory.ToUpperInvariant())));
        using var mutex = new Mutex(true, @"Local\DesktopMusicFloat-" + instance, out bool firstInstance);
        if (!firstInstance) return;

        string errorPath = Path.Combine(directory, "startup-error.txt");
        try
        {
            File.Delete(errorPath);
            ApplicationConfiguration.Initialize();
            using var bridge = new PlayerBridge(directory);
            using var window = new FloatingWindow(directory, bridge);
            var application = new System.Windows.Application { ShutdownMode = System.Windows.ShutdownMode.OnMainWindowClose };
            application.Run(window);
        }
        catch (Exception error)
        {
            File.WriteAllText(errorPath, error.ToString());
        }
    }
}
