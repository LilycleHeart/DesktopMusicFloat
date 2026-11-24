namespace DesktopMusicFloat;

internal sealed class EdgeTab : Form
{
    internal EdgeTab()
    {
        Text = "展开网易云桌面音乐悬浮窗";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        ShowInTaskbar = false;
        MinimumSize = new Size(1, 1);
        BackColor = Color.FromArgb(56, 50, 75);
        Cursor = Cursors.Hand;
    }

    protected override bool ShowWithoutActivation => true;

    internal void DockTo(DockEdge edge, Rectangle area, Rectangle card, int depth, int length)
    {
        int horizontal = Math.Clamp(card.X + (card.Width - length) / 2, area.Left, area.Right - length);
        int vertical = Math.Clamp(card.Y + (card.Height - length) / 2, area.Top, area.Bottom - length);
        Bounds = edge switch {
            DockEdge.Left => new Rectangle(area.Left, vertical, depth, length),
            DockEdge.Right => new Rectangle(area.Right - depth, vertical, depth, length),
            DockEdge.Top => new Rectangle(horizontal, area.Top, length, depth),
            _ => new Rectangle(horizontal, area.Bottom - depth, length, depth)
        };
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using var grip = new SolidBrush(Color.FromArgb(208, 197, 255));
        if (Width > Height) e.Graphics.FillRectangle(grip, Width / 4, Height / 3, Width / 2, Math.Max(2, Height / 3));
        else e.Graphics.FillRectangle(grip, Width / 3, Height / 4, Math.Max(2, Width / 3), Height / 2);
    }
}
