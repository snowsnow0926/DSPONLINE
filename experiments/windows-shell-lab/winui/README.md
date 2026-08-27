# WinUI 3 shell placeholder — No-Go

Status: **No-Go / not built**.

The machine has .NET 8, MSBuild, MSVC, Windows SDK 10.0.26100, Direct2D,
DirectWrite and D3D12 headers/libraries, plus Windows App Runtime packages. It
does not have the Windows App SDK development workload/targets/templates,
`Microsoft.WindowsAppSDK` NuGet package, or Win2D development package required
for a reproducible WinUI 3 build.

Installed runtimes are not a development SDK. Do not describe this placeholder
as a WinUI executable or use a bare Win32/Direct2D render harness as evidence
that WinUI IME, DPI, accessibility, lifecycle, packaging, or upgrade gates
passed.
