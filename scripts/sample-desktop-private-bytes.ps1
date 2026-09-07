param(
    [Parameter(Mandatory=$true)][string]$ProcessIds,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [Parameter(Mandatory=$true)][string]$ReadyPath,
    [Parameter(Mandatory=$true)][string]$StopPath
)
$ErrorActionPreference = 'Stop'
$sampleIds = [int[]]@($ProcessIds.Split(',') | ForEach-Object { [int]$_.Trim() })

# PrivateUsage is the Windows Private Bytes counter, not working set / RSS:
# https://learn.microsoft.com/en-us/windows/win32/memory/memory-performance-information
# Cache handles for these exact process instances; never enumerate or reopen a reused PID.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public sealed class DspDesktopPrivateBytesSampler : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessMemoryCountersEx
    {
        public uint cb;
        public uint PageFaultCount;
        public UIntPtr PeakWorkingSetSize;
        public UIntPtr WorkingSetSize;
        public UIntPtr QuotaPeakPagedPoolUsage;
        public UIntPtr QuotaPagedPoolUsage;
        public UIntPtr QuotaPeakNonPagedPoolUsage;
        public UIntPtr QuotaNonPagedPoolUsage;
        public UIntPtr PagefileUsage;
        public UIntPtr PeakPagefileUsage;
        public UIntPtr PrivateUsage;
    }

    private sealed class QueryHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public QueryHandle(IntPtr value) : base(true) { SetHandle(value); }
        protected override bool ReleaseHandle() { return CloseHandle(handle); }
    }

    private sealed class ProcessEntry
    {
        public int Id;
        public QueryHandle Handle;
        public bool Exited;
    }

    public sealed class SampleRow
    {
        public long timestampMs;
        public long privateBytes;
        public int[] processIds;
        public string[] priorities;
        public int[] requestedProcessIds;
        public int[] exitedProcessIds;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(QueryHandle handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetPriorityClass(QueryHandle handle);
    [DllImport("psapi.dll", SetLastError = true)]
    private static extern bool GetProcessMemoryInfo(QueryHandle handle, out ProcessMemoryCountersEx counters, uint size);

    private readonly int[] requestedIds;
    private readonly List<ProcessEntry> entries = new List<ProcessEntry>();
    public readonly List<SampleRow> Rows = new List<SampleRow>();

    public DspDesktopPrivateBytesSampler(int[] processIds)
    {
        if (processIds == null || processIds.Length == 0)
            throw new ArgumentException("At least one explicitly specified process ID is required.");
        requestedIds = (int[])processIds.Clone();
        var seen = new HashSet<int>();
        try
        {
            foreach (int id in requestedIds)
            {
                if (id <= 0 || !seen.Add(id))
                    throw new ArgumentException("Process IDs must be positive and unique: " + id);
                // PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE: query and observe exit only.
                IntPtr rawHandle = OpenProcess(0x1000 | 0x100000, false, id);
                if (rawHandle == IntPtr.Zero)
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot open requested process " + id);
                entries.Add(new ProcessEntry { Id = id, Handle = new QueryHandle(rawHandle) });
            }
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    private static bool HasExited(ProcessEntry entry)
    {
        uint wait = WaitForSingleObject(entry.Handle, 0);
        if (wait == 0) return true;
        if (wait == 258) return false;
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot query exit for requested process " + entry.Id);
    }

    private SampleRow Sample(bool firstSample)
    {
        var observed = new List<int>();
        var priorities = new List<string>();
        var exited = new List<int>();
        long total = 0;
        foreach (ProcessEntry entry in entries)
        {
            if (!entry.Exited) entry.Exited = HasExited(entry);
            if (entry.Exited)
            {
                if (firstSample)
                    throw new InvalidOperationException("Requested process exited before the first valid sample: " + entry.Id);
                exited.Add(entry.Id);
                continue;
            }
            ProcessMemoryCountersEx counters;
            bool memoryRead = GetProcessMemoryInfo(entry.Handle, out counters, (uint)Marshal.SizeOf(typeof(ProcessMemoryCountersEx)));
            int memoryError = memoryRead ? 0 : Marshal.GetLastWin32Error();
            uint priority = GetPriorityClass(entry.Handle);
            int priorityError = priority == 0 ? Marshal.GetLastWin32Error() : 0;
            // A process can exit between the preceding check and either query.
            entry.Exited = HasExited(entry);
            if (entry.Exited)
            {
                if (firstSample)
                    throw new InvalidOperationException("Requested process exited during the first sample: " + entry.Id);
                exited.Add(entry.Id);
                continue;
            }
            if (!memoryRead)
                throw new Win32Exception(memoryError, "Cannot read Private Bytes for requested process " + entry.Id);
            if (priority == 0)
                throw new Win32Exception(priorityError, "Cannot read priority for requested process " + entry.Id);
            total = checked(total + checked((long)counters.PrivateUsage.ToUInt64()));
            observed.Add(entry.Id);
            priorities.Add(((ProcessPriorityClass)priority).ToString());
        }
        return new SampleRow {
            timestampMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            privateBytes = total,
            processIds = observed.ToArray(),
            priorities = priorities.ToArray(),
            requestedProcessIds = requestedIds,
            exitedProcessIds = exited.ToArray()
        };
    }

    public void Run(string readyPath, string stopPath)
    {
        var clock = Stopwatch.StartNew();
        // Compilation / handle setup precede readiness; readiness requires every requested PID.
        Rows.Add(Sample(true));
        File.WriteAllText(readyPath, "ready");
        while (!File.Exists(stopPath) && clock.Elapsed.TotalSeconds < 180)
        {
            Thread.Sleep(25);
            if (File.Exists(stopPath) || clock.Elapsed.TotalSeconds >= 180) break;
            Rows.Add(Sample(false));
        }
    }

    public void Dispose()
    {
        foreach (ProcessEntry entry in entries) entry.Handle.Dispose();
    }
}
'@

$memorySampler = [DspDesktopPrivateBytesSampler]::new($sampleIds)
try {
    $memorySampler.Run($ReadyPath, $StopPath)
}
finally {
    try {
        $sampleJson = ConvertTo-Json -InputObject @($memorySampler.Rows.ToArray()) -Depth 4 -Compress
        [System.IO.File]::WriteAllText($OutputPath, $sampleJson, [System.Text.UTF8Encoding]::new($false))
    }
    finally {
        $memorySampler.Dispose()
    }
}
