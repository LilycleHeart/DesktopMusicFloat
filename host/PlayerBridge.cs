using System.Net;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace DesktopMusicFloat;

internal sealed class PlayerBridge : IDisposable
{
    private const int MaxPacket = 2 * 1024 * 1024;
    private readonly WebApplication server;
    private readonly string sessionPath;
    private readonly SemaphoreSlim sendGate = new(1, 1);
    private readonly CancellationTokenSource stopping = new();
    private readonly string token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    private WebSocket? player;
    private long lastMessage = Environment.TickCount64;
    private int port;
    private int connectedBefore;

    internal event Action<string>? Message;
    internal long IdleMilliseconds => Environment.TickCount64 - Interlocked.Read(ref lastMessage);
    internal bool HasConnected => Volatile.Read(ref connectedBefore) != 0;

    internal PlayerBridge(string directory)
    {
        sessionPath = Path.Combine(directory, "session.json");
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        server = builder.Build();
        server.UseWebSockets();
        server.Map("/player", AcceptPlayerAsync);
        server.StartAsync().GetAwaiter().GetResult();
        string address = server.Services.GetRequiredService<IServer>().Features
            .Get<IServerAddressesFeature>()!.Addresses.Single();
        Volatile.Write(ref port, new Uri(address).Port);
        string temporary = sessionPath + ".tmp";
        string version = typeof(PlayerBridge).Assembly.GetName().Version!.ToString(3);
        File.WriteAllText(temporary, JsonSerializer.Serialize(new { port, token, version }));
        File.Move(temporary, sessionPath, true);
    }

    private async Task AcceptPlayerAsync(HttpContext context)
    {
        if (!context.WebSockets.IsWebSocketRequest || context.Request.Host.Host != "127.0.0.1" ||
            context.Request.Host.Port != Volatile.Read(ref port))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        string candidate = context.Request.Query["token"].ToString();
        if (candidate.Length != token.Length ||
            !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(candidate), Encoding.UTF8.GetBytes(token)))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return;
        }

        using var connection = await context.WebSockets.AcceptWebSocketAsync();
        Interlocked.Exchange(ref player, connection)?.Abort();
        Interlocked.Exchange(ref lastMessage, Environment.TickCount64);
        Volatile.Write(ref connectedBefore, 1);
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted, stopping.Token);
        try
        {
            var buffer = new byte[16 * 1024];
            using var packet = new MemoryStream();
            while (connection.State == WebSocketState.Open)
            {
                var part = await connection.ReceiveAsync(buffer.AsMemory(), cancel.Token);
                if (part.MessageType != WebSocketMessageType.Text || packet.Length + part.Count > MaxPacket) break;
                packet.Write(buffer, 0, part.Count);
                if (!part.EndOfMessage) continue;
                HandlePacket(packet.GetBuffer().AsMemory(0, (int)packet.Length));
                packet.SetLength(0);
            }
        }
        catch (Exception error) when (error is OperationCanceledException or WebSocketException or JsonException)
        {
            // A closed or invalid publisher can reconnect with a fresh socket.
        }
        finally
        {
            if (Interlocked.CompareExchange(ref player, null, connection) == connection)
                Message?.Invoke("{\"type\":\"disconnected\"}");
        }
    }

    private void HandlePacket(ReadOnlyMemory<byte> packet)
    {
        using var document = JsonDocument.Parse(packet);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var type) ||
            type.ValueKind != JsonValueKind.String) return;
        switch (type.GetString())
        {
            case "snapshot":
            case "progress":
            case "volume":
            case "show":
            case "restore-interaction":
            case "quit":
                Message?.Invoke(root.GetRawText());
                break;
            case "heartbeat":
                break;
            default:
                return;
        }
        Interlocked.Exchange(ref lastMessage, Environment.TickCount64);
    }

    internal async Task SendCommandAsync(string action, string? id = null, double? ratio = null)
    {
        await sendGate.WaitAsync();
        try
        {
            var connection = Volatile.Read(ref player);
            if (connection?.State != WebSocketState.Open) return;
            byte[] packet = JsonSerializer.SerializeToUtf8Bytes(new { type = "command", action, id, ratio });
            await connection.SendAsync(packet.AsMemory(), WebSocketMessageType.Text, true, stopping.Token);
        }
        catch (Exception error) when (error is OperationCanceledException or WebSocketException or ObjectDisposedException)
        {
            // WebView input can race with a publisher disconnecting.
        }
        finally
        {
            sendGate.Release();
        }
    }

    public void Dispose()
    {
        stopping.Cancel();
        Volatile.Read(ref player)?.Abort();
        Task.Run(async () =>
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await server.StopAsync(timeout.Token);
            await server.DisposeAsync();
        }).GetAwaiter().GetResult();
        File.Delete(sessionPath);
        stopping.Dispose();
    }
}
