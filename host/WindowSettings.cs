using System.Text.Json;

namespace DesktopMusicFloat;

internal enum DockEdge { None, Left, Top, Right, Bottom }
internal enum LyricsAlignment { Auto, Left, Right }

internal sealed class WindowSettings
{
    public bool AlwaysOnTop { get; set; } = true;
    public bool ClickThrough { get; set; }
    public bool AutoHide { get; set; }
    public int? X { get; set; }
    public int? Y { get; set; }
    public DockEdge Edge { get; set; }
    public LyricsAlignment LyricsAlignment { get; set; }

    internal static WindowSettings Load(string path)
    {
        try { return JsonSerializer.Deserialize<WindowSettings>(File.ReadAllText(path)) ?? new(); }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) { return new(); }
    }

    internal void Save(string path)
    {
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(this));
        File.Move(temporary, path, true);
    }
}
