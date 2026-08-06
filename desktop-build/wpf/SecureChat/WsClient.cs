using System.Net.WebSockets;
using System.Text;
using System.Text.Json.Nodes;

namespace SecureChat;

public class WsClient : IDisposable
{
    private ClientWebSocket? _ws;
    private CancellationTokenSource? _cts;
    private bool _stopped;
    private readonly object _lock = new();

    public event Action<string, JsonObject?>? OnMessage;
    public event Action? OnClosed;

    public bool IsConnected => _ws?.State == WebSocketState.Open;

    public async Task StartAsync(string token)
    {
        _stopped = false;
        _cts = new CancellationTokenSource();
        int attempt = 0;
        while (!_stopped)
        {
            try
            {
                var ws = new ClientWebSocket();
                ws.Options.RemoteCertificateValidationCallback = (_, _, _, errors) =>
                    AppState.AllowInvalidCert || errors == System.Net.Security.SslPolicyErrors.None;
                await ws.ConnectAsync(new Uri(AppState.WsUrl), _cts.Token).ConfigureAwait(false);
                lock (_lock) { _ws?.Dispose(); _ws = ws; }
                attempt = 0;
                Send("auth", new JsonObject { ["token"] = token });
                await ReceiveLoopAsync(ws, _cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception)
            {
                if (_stopped) break;
            }
            if (_stopped) break;
            attempt++;
            var delay = TimeSpan.FromSeconds(Math.Min(2 * attempt, 15));
            try { await Task.Delay(delay, _cts.Token).ConfigureAwait(false); } catch { break; }
        }
        OnClosed?.Invoke();
    }

    private async Task ReceiveLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[128 * 1024];
        while (ws.State == WebSocketState.Open)
        {
            using var ms = new MemoryStream();
            WebSocketReceiveResult result;
            do
            {
                result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", ct).ConfigureAwait(false); } catch { }
                    return;
                }
                ms.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);

            var text = Encoding.UTF8.GetString(ms.ToArray());
            try
            {
                var root = JsonNode.Parse(text) as JsonObject;
                if (root == null) continue;
                var type = root["type"]?.GetValue<string>();
                var payload = root["payload"] as JsonObject;
                OnMessage?.Invoke(type ?? "", payload);
            }
            catch { }
        }
    }

    public void Send(string type, JsonObject? payload)
    {
        ClientWebSocket? ws;
        lock (_lock) ws = _ws;
        if (ws?.State != WebSocketState.Open) return;
        var root = new JsonObject
        {
            ["type"] = type,
            ["payload"] = payload
        };
        var bytes = Encoding.UTF8.GetBytes(root.ToJsonString());
        try
        {
            ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, _cts?.Token ?? CancellationToken.None)
                .GetAwaiter().GetResult();
        }
        catch { }
    }

    public void Stop()
    {
        _stopped = true;
        _cts?.Cancel();
        lock (_lock)
        {
            try { _ws?.Abort(); } catch { }
            _ws?.Dispose();
            _ws = null;
        }
    }

    public void Dispose() => Stop();
}
