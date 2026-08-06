using System.Runtime.InteropServices.WindowsRuntime;
using System.Windows;
using System.Windows.Media.Imaging;
using Windows.Graphics.Imaging;
using Windows.Media.Capture;
using Windows.Media.Capture.Frames;
using Windows.Media.Core;
using Windows.Media;
using ZXing;
using ZXing.Common;

namespace SecureChat;

public partial class QrScannerWindow : Window
{
    private MediaCapture? _capture;
    private MediaFrameReader? _frameReader;
    private readonly BarcodeReaderGeneric _reader;
    private bool _decoding;
    private bool _done;
    private long _lastUiTick;
    private WriteableBitmap? _preview;

    public string? QrText { get; private set; }

    public QrScannerWindow()
    {
        InitializeComponent();
        _reader = new BarcodeReaderGeneric
        {
            AutoRotate = true,
            Options = new DecodingOptions
            {
                TryHarder = true,
                PossibleFormats = new List<BarcodeFormat> { BarcodeFormat.QR_CODE }
            }
        };
        Loaded += async (_, _) => await StartCameraAsync();
        Closed += (_, _) => StopCamera();
    }

    private async Task StartCameraAsync()
    {
        try
        {
            _capture = new MediaCapture();
            await _capture.InitializeAsync(new MediaCaptureInitializationSettings
            {
                StreamingCaptureMode = StreamingCaptureMode.Video,
                MemoryPreference = MediaCaptureMemoryPreference.Cpu
            });

            var source = _capture.FrameSources.Values.FirstOrDefault(s =>
                             s.Info.SourceKind == MediaFrameSourceKind.Color &&
                             s.Info.MediaStreamType == MediaStreamType.VideoPreview)
                         ?? _capture.FrameSources.Values.FirstOrDefault(s => s.Info.SourceKind == MediaFrameSourceKind.Color);

            if (source == null)
            {
                StatusText.Text = "未找到可用摄像头";
                return;
            }

            _frameReader = await _capture.CreateFrameReaderAsync(source);
            _frameReader.FrameArrived += OnFrameArrived;
            var result = await _frameReader.StartAsync();
            if (result != MediaFrameReaderStartStatus.Success)
            {
                StatusText.Text = "摄像头启动失败（" + result + "）";
                return;
            }
            StatusText.Text = "请将二维码对准摄像头";
        }
        catch (Exception ex)
        {
            StatusText.Text = "摄像头不可用：" + ex.Message;
        }
    }

    private void OnFrameArrived(MediaFrameReader sender, MediaFrameArrivedEventArgs args)
    {
        if (_done) return;
        using var frame = sender.TryAcquireLatestFrame();
        var video = frame?.VideoMediaFrame;
        if (video == null) return;

        using SoftwareBitmap? sb = video.SoftwareBitmap;
        if (sb == null) return;

        SoftwareBitmap? bgra = null;
        try
        {
            bgra = SoftwareBitmap.Convert(sb, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore);

            var w = bgra.PixelWidth;
            var h = bgra.PixelHeight;
            var bytes = new byte[w * h * 4];
            bgra.CopyToBuffer(bytes.AsBuffer());

            var now = Environment.TickCount64;
            if (now - _lastUiTick > 66)
            {
                _lastUiTick = now;
                Dispatcher.BeginInvoke(() =>
                {
                    _preview ??= new WriteableBitmap(w, h, 96, 96, System.Windows.Media.PixelFormats.Bgra32, null);
                    if (_preview.PixelWidth != w || _preview.PixelHeight != h)
                        _preview = new WriteableBitmap(w, h, 96, 96, System.Windows.Media.PixelFormats.Bgra32, null);
                    _preview.WritePixels(new System.Windows.Int32Rect(0, 0, w, h), bytes, w * 4, 0);
                    PreviewImage.Source = _preview;
                });
            }

            if (!_decoding)
            {
                _decoding = true;
                var copy = bytes;
                var cw = w;
                var ch = h;
                Task.Run(() =>
                {
                    try
                    {
                        var luminance = new RGBLuminanceSource(copy, cw, ch, RGBLuminanceSource.BitmapFormat.BGRA32);
                        var result = _reader.Decode(luminance);
                        if (result != null && !string.IsNullOrEmpty(result.Text))
                        {
                            _done = true;
                            Dispatcher.BeginInvoke(() => Complete(result.Text));
                        }
                    }
                    catch { }
                    finally { _decoding = false; }
                });
            }
        }
        catch { }
        finally
        {
            bgra?.Dispose();
        }
    }

    private void Complete(string text)
    {
        StopCamera();
        QrText = text;
        DialogResult = true;
        Close();
    }

    private void StopCamera()
    {
        try { _frameReader?.FrameArrived -= OnFrameArrived; } catch { }
        try { _frameReader?.Dispose(); } catch { }
        try { _capture?.Dispose(); } catch { }
        _frameReader = null;
        _capture = null;
    }

    private void ManualOk_Click(object sender, RoutedEventArgs e)
    {
        var text = ManualText.Text.Trim();
        if (string.IsNullOrEmpty(text)) return;
        Complete(text);
    }
}
