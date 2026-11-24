using System.Text.Json;
using Wpf = System.Windows;
using Controls = System.Windows.Controls;
using Media = System.Windows.Media;
using Effects = System.Windows.Media.Effects;
using Shapes = System.Windows.Shapes;

namespace DesktopMusicFloat;

internal sealed class OverlaySurface : Controls.Grid
{
    private readonly Wpf.FrameworkElement web;
    private readonly Shapes.Rectangle accentGlow = CreateGlow(30, 0.36);
    private readonly Shapes.Rectangle whiteGlow = CreateGlow(19, 0.46);

    internal OverlaySurface(Wpf.FrameworkElement web)
    {
        this.web = web;
        web.Clip = Media.Geometry.Empty;
        var glow = new Controls.Canvas { IsHitTestVisible = false };
        glow.Children.Add(accentGlow);
        glow.Children.Add(whiteGlow);
        Children.Add(glow);
        Children.Add(web);
    }

    internal void Apply(JsonElement message)
    {
        if (!message.TryGetProperty("rects", out var rectangles) || rectangles.ValueKind != JsonValueKind.Array ||
            rectangles.GetArrayLength() is < 4 or > 6) return;
        var clip = new Media.GeometryGroup { FillRule = Media.FillRule.Nonzero };
        foreach (var value in rectangles.EnumerateArray())
        {
            if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() != 5) return;
            var coordinates = new double[5];
            int index = 0;
            foreach (var number in value.EnumerateArray())
            {
                if (number.ValueKind != JsonValueKind.Number ||
                    !number.TryGetDouble(out double coordinate) || !double.IsFinite(coordinate)) return;
                coordinates[index++] = coordinate;
            }
            var (x, y, width, height, radius) =
                (coordinates[0], coordinates[1], coordinates[2], coordinates[3], coordinates[4]);
            if (width <= 0 || height <= 0) continue;
            radius = Math.Clamp(radius, 0, Math.Min(width, height) / 2);
            clip.Children.Add(new Media.RectangleGeometry(new Wpf.Rect(x, y, width, height), radius, radius));
        }
        clip.Freeze();
        web.Clip = clip;

        if (clip.Children.Count == 0 || !message.TryGetProperty("glow", out var rgb) ||
            rgb.ValueKind != JsonValueKind.Array || rgb.GetArrayLength() != 3 ||
            !rgb[0].TryGetByte(out byte red) || !rgb[1].TryGetByte(out byte green) || !rgb[2].TryGetByte(out byte blue))
        {
            accentGlow.Visibility = whiteGlow.Visibility = Wpf.Visibility.Collapsed;
            return;
        }
        var art = (Media.RectangleGeometry)clip.Children[0];
        PlaceGlow(accentGlow, art, Media.Color.FromRgb(red, green, blue));
        PlaceGlow(whiteGlow, art, Media.Colors.White);
    }

    internal Wpf.Point PointInWeb(Point screenPoint) =>
        web.PointFromScreen(new Wpf.Point(screenPoint.X, screenPoint.Y));

    internal bool Contains(Point screenPoint) => web.Clip.FillContains(PointInWeb(screenPoint));

    private static Shapes.Rectangle CreateGlow(double blur, double opacity) => new()
    {
        Fill = Media.Brushes.Black,
        Visibility = Wpf.Visibility.Collapsed,
        Effect = new Effects.DropShadowEffect { BlurRadius = blur, Opacity = opacity, ShadowDepth = 0 }
    };

    private static void PlaceGlow(Shapes.Rectangle shape, Media.RectangleGeometry art, Media.Color color)
    {
        Controls.Canvas.SetLeft(shape, art.Rect.X);
        Controls.Canvas.SetTop(shape, art.Rect.Y);
        shape.Width = art.Rect.Width;
        shape.Height = art.Rect.Height;
        shape.RadiusX = art.RadiusX;
        shape.RadiusY = art.RadiusY;
        ((Effects.DropShadowEffect)shape.Effect).Color = color;
        shape.Visibility = Wpf.Visibility.Visible;
    }
}
