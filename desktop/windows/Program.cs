using System.Diagnostics;
using System.IO.Compression;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Gatherzap;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        string? smokeRoot = null;
        if (args.Length == 2 && args[0] == "--smoke-test-root") smokeRoot = Path.GetFullPath(args[1]);
        var root = smokeRoot ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "gatherzap");
        var identity = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(root.ToUpperInvariant())))[..16];
        var pipeName = "gatherzap-" + identity;
        using var mutex = new Mutex(false, @"Local\" + pipeName);
        bool ownsMutex;
        try { ownsMutex = mutex.WaitOne(0); }
        catch (AbandonedMutexException) { ownsMutex = true; }
        if (!ownsMutex)
        {
            try
            {
                using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.Out);
                pipe.Connect(4000);
                using var writer = new StreamWriter(pipe) { AutoFlush = true };
                writer.WriteLine("open");
            }
            catch { MessageBox.Show("gatherzap is already starting. Open it from its tray icon in a moment.", "gatherzap"); }
            return;
        }
        try
        {
            Directory.CreateDirectory(root);
            using var host = new HostContext(root, pipeName, smokeRoot != null);
            Application.Run(host);
        }
        catch (Exception error)
        {
            if (smokeRoot != null)
            {
                File.WriteAllText(Path.Combine(root, "smoke-error.txt"), "launcher_failed");
                File.WriteAllText(Path.Combine(root, "smoke-error-detail.txt"), error.ToString());
            }
            else MessageBox.Show("gatherzap could not start. Check that your local user folder is writable, then try again.", "gatherzap", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally { mutex.ReleaseMutex(); }
    }
}

internal sealed class HostContext : ApplicationContext
{
    private readonly string root;
    private readonly string pipeName;
    private readonly bool smokeTest;
    private readonly Form dispatcher = new() { ShowInTaskbar = false };
    private readonly CancellationTokenSource lifetime = new();
    private readonly NotifyIcon tray;
    private readonly ContextMenuStrip menu = new();
    private Process? worker;
    private ProcessJob? job;
    private string? url;
    private string? runtimeVersion;
    private bool closing;
    private bool ready;
    private bool failureShown;
    private bool disposed;

    public HostContext(string root, string pipeName, bool smokeTest)
    {
        this.root = root; this.pipeName = pipeName; this.smokeTest = smokeTest;
        _ = dispatcher.Handle; // Invisible window used only to dispatch tray/IPC events.
        menu.Items.Add("Open gatherzap", null, (_, _) => OpenBrowser());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit gatherzap", null, async (_, _) => await StopAsync());
        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "gatherzap — starting", ContextMenuStrip = menu, Visible = !smokeTest };
        tray.DoubleClick += (_, _) => OpenBrowser();
        _ = ListenForOpenRequestsAsync();
        Application.Idle += BeginStartup;
    }

    private async void BeginStartup(object? sender, EventArgs args)
    {
        Application.Idle -= BeginStartup;
        try
        {
            var runtime = await Task.Run(ExtractRuntime);
            if (closing) return;
            var info = new ProcessStartInfo(Path.Combine(runtime, "node.exe"))
            {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                WorkingDirectory = runtime,
            };
            info.ArgumentList.Add(Path.Combine(runtime, "desktop", "server.js"));
            if (smokeTest) info.ArgumentList.Add("--smoke-test");
            info.Environment["GATHERZAP_DATA_ROOT"] = root;
            info.Environment["PUPPETEER_EXECUTABLE_PATH"] = Path.Combine(runtime, "browser", "chrome.exe");
            if (smokeTest) info.Environment["UI_PORT"] = "0";
            worker = new Process { StartInfo = info, EnableRaisingEvents = true };
            worker.OutputDataReceived += (_, value) => Receive(value.Data);
            worker.Exited += (_, _) => Dispatch(async () => { if (!closing) await FailAsync("server_stopped"); });
            if (!worker.Start()) throw new InvalidOperationException();
            job = ProcessJob.TryCreate(worker);
            worker.BeginOutputReadLine(); worker.BeginErrorReadLine();
            _ = CheckStartupTimeoutAsync();
        }
        catch { await FailAsync("startup_failed"); }
    }

    private string ExtractRuntime()
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var manifest = JsonDocument.Parse(assembly.GetManifestResourceStream("gatherzap.manifest")!);
        var id = manifest.RootElement.GetProperty("id").GetString()!;
        if (id.Length != 64 || id.Any(character => !Uri.IsHexDigit(character))) throw new InvalidDataException();
        var runtime = Path.Combine(root, "runtime", id[..16]);
        var marker = Path.Combine(runtime, "bundle.complete");
        if (File.Exists(marker) && File.ReadAllText(marker) == id && File.Exists(Path.Combine(runtime, "node.exe")) && File.Exists(Path.Combine(runtime, "browser", "chrome.exe"))) return runtime;
        var temporary = Path.Combine(root, "runtime", ".extract-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temporary);
        using var payload = assembly.GetManifestResourceStream("gatherzap.payload")!;
        using var archive = new ZipArchive(payload, ZipArchiveMode.Read);
        archive.ExtractToDirectory(temporary);
        if (!File.Exists(Path.Combine(temporary, "node.exe")) || !File.Exists(Path.Combine(temporary, "browser", "chrome.exe"))) throw new InvalidDataException();
        File.WriteAllText(Path.Combine(temporary, "bundle.complete"), id);
        Directory.Move(temporary, runtime);
        return runtime;
    }

    private void Receive(string? line)
    {
        if (line == null || closing) return;
        try
        {
            using var message = JsonDocument.Parse(line);
            var value = message.RootElement;
            if (!value.TryGetProperty("event", out var kind)) return;
            if (kind.GetString() == "error")
            {
                var code = value.GetProperty("code").GetString();
                Dispatch(async () => await FailAsync(code ?? "startup_failed"));
            }
            if (kind.GetString() != "ready" || ready) return;
            var address = value.GetProperty("url").GetString();
            if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme != "http" || uri.Host != "127.0.0.1" || uri.Port < 1 || uri.AbsolutePath != "/") return;
            var version = value.GetProperty("runtimeVersion").GetString();
            Dispatch(async () =>
            {
                if (closing || ready) return;
                ready = true; url = uri.GetLeftPart(UriPartial.Authority); runtimeVersion = version;
                tray.Text = "gatherzap — running";
                if (smokeTest) await VerifySmokeTestAsync();
                else OpenBrowser();
            });
        }
        catch { /* Ignore non-protocol output; never persist raw logs or secrets. */ }
    }

    private async Task VerifySmokeTestAsync()
    {
        try
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            var html = await http.GetStringAsync(url);
            using var state = JsonDocument.Parse(await http.GetStringAsync(url + "/api/state"));
            if (!html.Contains("gatherzap") || !state.RootElement.GetProperty("whatsappReady").GetBoolean()) throw new InvalidDataException();
            worker!.Refresh();
            var report = new { success = true, url, runtimeVersion, consoleWindow = Native.GetConsoleWindow() != IntPtr.Zero,
                workerWindow = worker.MainWindowHandle.ToInt64(), jobAssigned = job != null, workerId = worker.Id,
                browserIncluded = File.Exists(Path.Combine(worker.StartInfo.WorkingDirectory, "browser", "chrome.exe")) };
            File.WriteAllText(Path.Combine(root, "smoke-report.json"), JsonSerializer.Serialize(report));
        }
        catch { File.WriteAllText(Path.Combine(root, "smoke-error.txt"), "server_verification_failed"); }
        await StopAsync();
    }

    private async Task CheckStartupTimeoutAsync()
    {
        try { await Task.Delay(TimeSpan.FromSeconds(45), lifetime.Token); }
        catch (OperationCanceledException) { return; }
        if (!ready && !closing) Dispatch(async () => await FailAsync("startup_failed"));
    }

    private async Task ListenForOpenRequestsAsync()
    {
        while (!lifetime.IsCancellationRequested)
        {
            try
            {
                using var pipe = new NamedPipeServerStream(pipeName, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(lifetime.Token);
                using var reader = new StreamReader(pipe);
                if (await reader.ReadLineAsync(lifetime.Token) == "open") Dispatch(OpenBrowser);
            }
            catch (OperationCanceledException) { return; }
            catch { if (lifetime.IsCancellationRequested) return; await Task.Delay(250); }
        }
    }

    private void OpenBrowser()
    {
        if (closing || smokeTest) return;
        if (url == null) { tray.ShowBalloonTip(2500, "gatherzap", "Starting the local server…", ToolTipIcon.Info); return; }
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch { MessageBox.Show("Open " + url + " in your browser.", "gatherzap"); }
    }

    private async Task FailAsync(string code)
    {
        if (closing || failureShown) return;
        failureShown = true;
        if (smokeTest) File.WriteAllText(Path.Combine(root, "smoke-error.txt"), code);
        else
        {
            var message = code == "EADDRINUSE" ? "The dashboard port is already in use. Close any existing gatherzap server, then try again."
                : code == "browser_missing" ? "The bundled browser is missing. Run a fresh copy of gatherzap.exe."
                : "The local server could not keep running. Quit other gatherzap instances, then restart the app.";
            MessageBox.Show(message, "gatherzap", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        await StopAsync();
    }

    private async Task StopAsync()
    {
        if (closing) return;
        closing = true; tray.Visible = false; lifetime.Cancel();
        try
        {
            if (worker != null && !worker.HasExited)
            {
                try { await worker.StandardInput.WriteLineAsync("shutdown"); await worker.StandardInput.FlushAsync(); }
                catch { }
                try { await worker.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30)); }
                catch { if (!worker.HasExited) worker.Kill(entireProcessTree: true); }
            }
        }
        finally { job?.Dispose(); job = null; Dispatch(ExitThread); }
    }

    private void Dispatch(Action action)
    {
        if (dispatcher.IsDisposed) return;
        try { dispatcher.BeginInvoke(action); } catch (InvalidOperationException) { }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !disposed)
        {
            disposed = true;
            lifetime.Cancel(); job?.Dispose(); tray.Dispose(); menu.Dispose(); dispatcher.Dispose(); lifetime.Dispose(); worker?.Dispose();
        }
        base.Dispose(disposing);
    }
}

internal sealed class ProcessJob : IDisposable
{
    private IntPtr handle;
    private ProcessJob(IntPtr handle) { this.handle = handle; }
    public static ProcessJob? TryCreate(Process process)
    {
        var handle = Native.CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) return null;
        var limits = new Native.JobLimits { Basic = new Native.BasicLimits { LimitFlags = 0x2000 } }; // KILL_ON_JOB_CLOSE
        var size = Marshal.SizeOf<Native.JobLimits>();
        var memory = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, memory, false);
            if (Native.SetInformationJobObject(handle, 9, memory, (uint)size) && Native.AssignProcessToJobObject(handle, process.Handle)) return new ProcessJob(handle);
            Native.CloseHandle(handle); return null;
        }
        finally { Marshal.FreeHGlobal(memory); }
    }
    public void Dispose() { if (handle != IntPtr.Zero) { Native.CloseHandle(handle); handle = IntPtr.Zero; } }
}

internal static class Native
{
    [DllImport("kernel32.dll")] internal static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr information, uint length);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] internal struct BasicLimits
    {
        public long PerProcessTime, PerJobTime;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct IoCounters { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] internal struct JobLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
    }
}
