[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Check", "Stage")]
    [string]$Action,
    [Parameter(Mandatory = $true)]
    [string]$PackageRoot,
    [Parameter(Mandatory = $true)]
    [string]$StateDirectory,
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 65535)]
    [int]$Port,
    [string]$CandidateId,
    [string]$StartedAt,
    [switch]$AllowTestHttpLoopback
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2

$protocolVersion = 1
$maximumManifestBytes = 1MB
$maximumSignatureBytes = 16KB
$maximumReleaseBytes = 2MB
$maximumArchiveBytes = 512MB
$candidateLifetimeHours = 24
$utf8 = New-Object Text.UTF8Encoding($false, $true)
$protectedUpdateLogPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

function Protect-UpdateLogMessage {
    param([string]$Message)
    $text = if ($null -eq $Message) { "" } else { [string]$Message }
    $wasTruncated = $text.Length -gt 16384
    if ($wasTruncated) { $text = $text.Substring(0, [Math]::Min($text.Length, 16512)) }
    $text = $text -replace '[\u0000-\u001f\u007f-\u009f\u2028\u2029]+', ' '
    $text = $text -replace '(?i)\b(cookie|set-cookie)\s*[:=].*$', '${1}=[REDACTED]'
    $text = $text -replace '(?i)\b(authorization|proxy-authorization|x-tarkov-[a-z0-9-]+)\s*[:=].*$', '${1}=[REDACTED]'
    $text = $text -replace '(?i)(?<![A-Za-z0-9_])["'']?(token|nonce|secret|password|api[-_]?key|claimid|overlayid|candidateid|healthnonce|updatenonce|controltoken|leasetoken)["'']?\s*[:=].*$', '${1}=[REDACTED]'
    $text = $text -replace '(?i)\b(https?://)[^/@\s]+@', '$1[REDACTED]@'
    $text = $text -replace '(?i)(https?://[^\s?#]+)[?#][^\s]+', '$1?[REDACTED]'
    $text = $text -replace '(?i)(?<![A-Za-z0-9_])file:/+(?:localhost/)?(?:[A-Z]:/)?[^"<>\u0000-\u001f\u007f-\u009f\u2028\u2029]+', '[REDACTED]'
    $text = $text -replace '(?i)(?<![A-Za-z0-9_])(?:[A-Z]:[\\/]|\\\\)[^"<>|\r\n\u2028\u2029]+', '[REDACTED]'
    $text = $text -replace '(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])', '[REDACTED]'
    $text = $text.Trim()
    if ($wasTruncated) {
        if ($text.Length -gt 128) { $text = $text.Substring(0, $text.Length - 128).TrimEnd() } else { $text = "" }
        $text = ($text + " [TRUNCATED]").Trim()
    }
    $encoding = New-Object Text.UTF8Encoding($false)
    if ($encoding.GetByteCount($text) -gt 3800) {
        $low = 0; $high = $text.Length
        while ($low -lt $high) {
            $middle = [int][Math]::Ceiling(($low + $high) / 2.0)
            if ($encoding.GetByteCount($text.Substring(0, $middle) + "...") -le 3800) { $low = $middle } else { $high = $middle - 1 }
        }
        $text = $text.Substring(0, $low) + "..."
    }
    return $text
}

function Get-UpdateLogDirectory {
    $directory = Join-Path ([IO.Path]::GetFullPath($StateDirectory)) "app-update"
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    if (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The update log directory is unsafe.") }
    return $directory
}

function Get-UpdateLogMutexName {
    $normalized = [IO.Path]::GetFullPath($StateDirectory).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar).ToUpperInvariant()
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $bytes = $hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalized)) } finally { $hash.Dispose() }
    return "Local\TarkovHelperWebLog" + ([BitConverter]::ToString($bytes, 0, 12)).Replace("-", "")
}

function Protect-UpdateLogFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not [IO.File]::Exists($Path)) { return $true }
    $temporary = $null
    try {
        $fullPath = [IO.Path]::GetFullPath($Path)
        $directory = [IO.Path]::GetDirectoryName($fullPath)
        if (([IO.DirectoryInfo]::new($directory).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The diagnostic log directory is unsafe.") }
        $info = [IO.FileInfo]::new($fullPath)
        if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The diagnostic log file is unsafe.") }
        $maximumBytes = 1048576
        $tailOnly = $info.Length -gt $maximumBytes
        $count = [int][Math]::Min([long]$maximumBytes, $info.Length)
        $bytes = New-Object byte[] $count
        $source = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            if ($tailOnly) { $null = $source.Seek(-[long]$count, [IO.SeekOrigin]::End) }
            $offset = 0
            while ($offset -lt $count) { $read = $source.Read($bytes, $offset, $count - $offset); if ($read -le 0) { break }; $offset += $read }
            if ($offset -ne $count) { throw [IO.EndOfStreamException]::new("The diagnostic log could not be read safely.") }
        } finally { $source.Dispose() }
        $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
        $text = $strictUtf8.GetString($bytes)
        if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
        if ($tailOnly) {
            $boundary = [regex]::Match($text, '\r\n|[\r\n\u0085\u2028\u2029]')
            $text = if ($boundary.Success) { $text.Substring($boundary.Index + $boundary.Length) } else { "" }
        }
        $segments = [regex]::Split($text, '\r\n|[\r\n\u0085\u2028\u2029]')
        $protectedLines = New-Object 'Collections.Generic.List[string]'
        $first = [int][Math]::Max(0, $segments.Length - 4096)
        for ($index = $first; $index -lt $segments.Length; $index++) {
            $protected = Protect-UpdateLogMessage ([string]$segments[$index])
            if (-not [string]::IsNullOrWhiteSpace($protected)) { $protectedLines.Add($protected) }
        }
        $encoding = New-Object Text.UTF8Encoding($false)
        $keptReverse = New-Object 'Collections.Generic.List[string]'
        $keptBytes = 0
        for ($index = $protectedLines.Count - 1; $index -ge 0; $index--) {
            $line = $protectedLines[$index] + [Environment]::NewLine
            $lineBytes = $encoding.GetByteCount($line)
            if (($keptBytes + $lineBytes) -gt $maximumBytes) { break }
            $keptReverse.Add($line); $keptBytes += $lineBytes
        }
        $builder = New-Object Text.StringBuilder
        for ($index = $keptReverse.Count - 1; $index -ge 0; $index--) { $null = $builder.Append($keptReverse[$index]) }
        $sanitizedBytes = $encoding.GetBytes($builder.ToString())
        $temporary = Join-Path $directory ("." + [IO.Path]::GetFileName($fullPath) + "." + [Guid]::NewGuid().ToString("N") + ".sanitize.tmp")
        [IO.File]::WriteAllBytes($temporary, $sanitizedBytes)
        [IO.File]::Delete($fullPath); [IO.File]::Move($temporary, $fullPath)
        return $true
    } catch {
        try { if ([IO.File]::Exists($Path)) { [IO.File]::Delete($Path) }; return -not [IO.File]::Exists($Path) } catch { return $false }
    } finally {
        if ($null -ne $temporary -and [IO.File]::Exists($temporary)) { try { [IO.File]::Delete($temporary) } catch { } }
    }
}

function Rotate-UpdateLogFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateRange(0, 4096)][int]$AdditionalBytes = 0
    )
    $temporary = $null
    try {
        if (-not [IO.File]::Exists($Path) -or (([IO.FileInfo]::new($Path)).Length + $AdditionalBytes) -le 1048576) { return }
        $directory = [IO.Path]::GetDirectoryName($Path)
        $previous = Join-Path $directory ([IO.Path]::GetFileNameWithoutExtension($Path) + ".previous" + [IO.Path]::GetExtension($Path))
        $temporary = Join-Path $directory ("." + [IO.Path]::GetFileName($previous) + "." + [Guid]::NewGuid().ToString("N") + ".tmp")
        $source = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            $count = [int][Math]::Min([long]1048576, $source.Length)
            $null = $source.Seek(-[long]$count, [IO.SeekOrigin]::End)
            $bytes = New-Object byte[] $count; $offset = 0
            while ($offset -lt $count) { $read = $source.Read($bytes, $offset, $count - $offset); if ($read -le 0) { break }; $offset += $read }
            if ($offset -ne $count) { throw [IO.EndOfStreamException]::new("The diagnostic log tail could not be read.") }
            [IO.File]::WriteAllBytes($temporary, $bytes)
        } finally { $source.Dispose() }
        if ([IO.File]::Exists($previous)) { [IO.File]::Delete($previous) }
        [IO.File]::Move($temporary, $previous); [IO.File]::Delete($Path)
    } catch { } finally {
        if ($null -ne $temporary -and [IO.File]::Exists($temporary)) { try { [IO.File]::Delete($temporary) } catch { } }
    }
}

function Write-WorkerLog {
    param([string]$Message)
    $mutex = $null; $hasMutex = $false
    try {
        $directory = Get-UpdateLogDirectory
        $mutex = [Threading.Mutex]::new($false, (Get-UpdateLogMutexName))
        try { $hasMutex = $mutex.WaitOne(200) } catch [Threading.AbandonedMutexException] { $hasMutex = $true }
        if (-not $hasMutex) { return }
        $path = Join-Path $directory "worker.log"
        $previousPath = Join-Path $directory "worker.previous.log"
        foreach ($candidateLogPath in @($previousPath, $path)) {
            if (-not $script:protectedUpdateLogPaths.Contains($candidateLogPath)) {
                if (-not (Protect-UpdateLogFile -Path $candidateLogPath)) { return }
                $null = $script:protectedUpdateLogPaths.Add($candidateLogPath)
            }
        }
        $line = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture) + " " + (Protect-UpdateLogMessage $Message) + [Environment]::NewLine
        $encoding = New-Object Text.UTF8Encoding($false)
        $lineBytes = $encoding.GetByteCount($line)
        Rotate-UpdateLogFile -Path $path -AdditionalBytes $lineBytes
        if ([IO.File]::Exists($path) -and (([IO.FileInfo]::new($path)).Length + $lineBytes) -gt 1048576) { return }
        [IO.File]::AppendAllText($path, $line, $encoding)
    } catch { } finally {
        if ($hasMutex) { try { $mutex.ReleaseMutex() } catch { } }
        if ($null -ne $mutex) { try { $mutex.Dispose() } catch { } }
    }
}

if (
    -not [string]::IsNullOrWhiteSpace($StartedAt) -and
    $StartedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$'
) {
    Write-WorkerLog "Worker initialization failed because the operation start time is invalid."
    exit 8
}

$supportSource = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace TarkovHelperUpdateSupport
{
    public static class StrictJson
    {
        private sealed class Parser
        {
            private readonly string text;
            private int index;

            internal Parser(string value) { text = value; }

            internal void Parse()
            {
                SkipWhite();
                ParseValue();
                SkipWhite();
                if (index != text.Length) Fail("trailing data");
            }

            private void ParseValue()
            {
                if (index >= text.Length) Fail("missing value");
                char value = text[index];
                if (value == '{') { ParseObject(); return; }
                if (value == '[') { ParseArray(); return; }
                if (value == '"') { ParseString(); return; }
                if (value == 't') { Literal("true"); return; }
                if (value == 'f') { Literal("false"); return; }
                if (value == 'n') { Literal("null"); return; }
                ParseNumber();
            }

            private void ParseObject()
            {
                index++;
                SkipWhite();
                HashSet<string> names = new HashSet<string>(StringComparer.Ordinal);
                if (Take('}')) return;
                while (true)
                {
                    if (index >= text.Length || text[index] != '"') Fail("object key");
                    string name = ParseString();
                    if (!names.Add(name)) Fail("duplicate object key");
                    SkipWhite();
                    Require(':');
                    SkipWhite();
                    ParseValue();
                    SkipWhite();
                    if (Take('}')) return;
                    Require(',');
                    SkipWhite();
                }
            }

            private void ParseArray()
            {
                index++;
                SkipWhite();
                if (Take(']')) return;
                while (true)
                {
                    ParseValue();
                    SkipWhite();
                    if (Take(']')) return;
                    Require(',');
                    SkipWhite();
                }
            }

            private string ParseString()
            {
                Require('"');
                StringBuilder result = new StringBuilder();
                while (index < text.Length)
                {
                    char value = text[index++];
                    if (value == '"') return result.ToString();
                    if (value < 0x20) Fail("control character in string");
                    if (value != '\\') { result.Append(value); continue; }
                    if (index >= text.Length) Fail("truncated escape");
                    char escape = text[index++];
                    switch (escape)
                    {
                        case '"': result.Append('"'); break;
                        case '\\': result.Append('\\'); break;
                        case '/': result.Append('/'); break;
                        case 'b': result.Append('\b'); break;
                        case 'f': result.Append('\f'); break;
                        case 'n': result.Append('\n'); break;
                        case 'r': result.Append('\r'); break;
                        case 't': result.Append('\t'); break;
                        case 'u':
                            if (index + 4 > text.Length) Fail("truncated unicode escape");
                            int code;
                            if (!Int32.TryParse(text.Substring(index, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code))
                                Fail("invalid unicode escape");
                            result.Append((char)code);
                            index += 4;
                            break;
                        default: Fail("invalid escape"); break;
                    }
                }
                Fail("unterminated string");
                return null;
            }

            private void ParseNumber()
            {
                int start = index;
                if (Take('-')) { }
                if (Take('0'))
                {
                    if (index < text.Length && Char.IsDigit(text[index])) Fail("leading zero");
                }
                else
                {
                    if (index >= text.Length || text[index] < '1' || text[index] > '9') Fail("number");
                    while (index < text.Length && Char.IsDigit(text[index])) index++;
                }
                if (Take('.'))
                {
                    if (index >= text.Length || !Char.IsDigit(text[index])) Fail("fraction");
                    while (index < text.Length && Char.IsDigit(text[index])) index++;
                }
                if (index < text.Length && (text[index] == 'e' || text[index] == 'E'))
                {
                    index++;
                    if (index < text.Length && (text[index] == '+' || text[index] == '-')) index++;
                    if (index >= text.Length || !Char.IsDigit(text[index])) Fail("exponent");
                    while (index < text.Length && Char.IsDigit(text[index])) index++;
                }
                if (start == index) Fail("number");
            }

            private void Literal(string value)
            {
                if (index + value.Length > text.Length || String.CompareOrdinal(text, index, value, 0, value.Length) != 0)
                    Fail("literal");
                index += value.Length;
            }

            private void SkipWhite()
            {
                while (index < text.Length && (text[index] == ' ' || text[index] == '\t' || text[index] == '\r' || text[index] == '\n')) index++;
            }

            private bool Take(char value)
            {
                if (index < text.Length && text[index] == value) { index++; return true; }
                return false;
            }

            private void Require(char value)
            {
                if (!Take(value)) Fail("expected " + value);
            }

            private void Fail(string message) { throw new InvalidDataException("Invalid JSON: " + message + "."); }
        }

        public static string DecodeAndValidate(byte[] bytes)
        {
            if (bytes == null || bytes.Length == 0) throw new InvalidDataException("JSON is empty.");
            if (bytes.Length >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf)
                throw new InvalidDataException("JSON must not contain a BOM.");
            string text = new UTF8Encoding(false, true).GetString(bytes);
            new Parser(text).Parse();
            return text;
        }
    }

    public static class RsaManifest
    {
        private sealed class Der
        {
            private readonly byte[] data;
            private int offset;
            internal Der(byte[] value) { data = value; }
            internal int Remaining { get { return data.Length - offset; } }
            internal byte ReadByte() { if (offset >= data.Length) Fail(); return data[offset++]; }
            internal byte[] ReadValue(byte tag)
            {
                if (ReadByte() != tag) Fail();
                int length = ReadLength();
                if (length < 0 || length > Remaining) Fail();
                byte[] value = new byte[length];
                Buffer.BlockCopy(data, offset, value, 0, length);
                offset += length;
                return value;
            }
            internal Der ReadSequence() { return new Der(ReadValue(0x30)); }
            internal void End() { if (Remaining != 0) Fail(); }
            private int ReadLength()
            {
                int first = ReadByte();
                if ((first & 0x80) == 0) return first;
                int count = first & 0x7f;
                if (count == 0 || count > 4 || count > Remaining) Fail();
                int value = 0;
                for (int i = 0; i < count; i++)
                {
                    int next = ReadByte();
                    if (i == 0 && next == 0) Fail();
                    if (value > (Int32.MaxValue >> 8)) Fail();
                    value = (value << 8) | next;
                }
                if (value < 128) Fail();
                return value;
            }
            private static void Fail() { throw new CryptographicException("The SPKI public key is invalid."); }
        }

        private static byte[] PositiveInteger(Der value)
        {
            byte[] number = value.ReadValue(0x02);
            if (number.Length == 0 || (number[0] & 0x80) != 0) throw new CryptographicException("The RSA integer is invalid.");
            if (number.Length > 1 && number[0] == 0 && (number[1] & 0x80) == 0)
                throw new CryptographicException("The RSA integer is non-canonical.");
            if (number.Length > 1 && number[0] == 0)
            {
                byte[] trimmed = new byte[number.Length - 1];
                Buffer.BlockCopy(number, 1, trimmed, 0, trimmed.Length);
                return trimmed;
            }
            return number;
        }

        private static byte[] PemToDer(string pem)
        {
            const string begin = "-----BEGIN PUBLIC KEY-----";
            const string end = "-----END PUBLIC KEY-----";
            if (pem == null || pem.Length > 32768) throw new CryptographicException("The public key is invalid.");
            int start = pem.IndexOf(begin, StringComparison.Ordinal);
            int finish = pem.IndexOf(end, StringComparison.Ordinal);
            if (start < 0 || finish < 0 || pem.IndexOf(begin, start + 1, StringComparison.Ordinal) >= 0 || pem.IndexOf(end, finish + 1, StringComparison.Ordinal) >= 0)
                throw new CryptographicException("The public key PEM block is invalid.");
            if (pem.Substring(0, start).Trim().Length != 0 || pem.Substring(finish + end.Length).Trim().Length != 0)
                throw new CryptographicException("The public key PEM has extra data.");
            string body = pem.Substring(start + begin.Length, finish - start - begin.Length);
            StringBuilder compact = new StringBuilder();
            foreach (char value in body)
            {
                if (value == ' ' || value == '\t' || value == '\r' || value == '\n') continue;
                compact.Append(value);
            }
            byte[] der;
            try { der = Convert.FromBase64String(compact.ToString()); }
            catch (FormatException error) { throw new CryptographicException("The public key PEM is invalid.", error); }
            if (der.Length == 0 || der.Length > 16384) throw new CryptographicException("The public key DER is invalid.");
            return der;
        }

        private static string Hex(byte[] bytes)
        {
            StringBuilder result = new StringBuilder(bytes.Length * 2);
            foreach (byte value in bytes) result.Append(value.ToString("x2", CultureInfo.InvariantCulture));
            return result.ToString();
        }

        public static bool Verify(byte[] contents, byte[] signature, string publicKeyPem, string expectedKeyId)
        {
            byte[] spki = PemToDer(publicKeyPem);
            byte[] keyHash;
            using (SHA256 hash = SHA256.Create()) keyHash = hash.ComputeHash(spki);
            if (!String.Equals("sha256:" + Hex(keyHash), expectedKeyId, StringComparison.Ordinal))
                throw new CryptographicException("The signing key identifier does not match.");

            Der document = new Der(spki);
            Der outer = document.ReadSequence();
            document.End();
            Der algorithm = outer.ReadSequence();
            byte[] oid = algorithm.ReadValue(0x06);
            byte[] rsaOid = new byte[] { 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01 };
            if (oid.Length != rsaOid.Length) throw new CryptographicException("The signing key algorithm is invalid.");
            for (int i = 0; i < oid.Length; i++) if (oid[i] != rsaOid[i]) throw new CryptographicException("The signing key algorithm is invalid.");
            byte[] nullValue = algorithm.ReadValue(0x05);
            if (nullValue.Length != 0) throw new CryptographicException("The signing key parameters are invalid.");
            algorithm.End();
            byte[] bitString = outer.ReadValue(0x03);
            outer.End();
            if (bitString.Length < 2 || bitString[0] != 0) throw new CryptographicException("The signing key bit string is invalid.");
            byte[] rsaBytes = new byte[bitString.Length - 1];
            Buffer.BlockCopy(bitString, 1, rsaBytes, 0, rsaBytes.Length);
            Der rsaDocument = new Der(rsaBytes);
            Der rsa = rsaDocument.ReadSequence();
            rsaDocument.End();
            byte[] modulus = PositiveInteger(rsa);
            byte[] exponent = PositiveInteger(rsa);
            rsa.End();
            if (modulus.Length < 384 || modulus.Length > 2048 || (modulus[0] & 0x80) == 0)
                throw new CryptographicException("The RSA modulus size is invalid.");
            ulong exponentValue = 0;
            if (exponent.Length == 0 || exponent.Length > 4) throw new CryptographicException("The RSA exponent is invalid.");
            foreach (byte value in exponent) exponentValue = (exponentValue << 8) | value;
            if (exponentValue < 65537 || (exponentValue & 1) == 0) throw new CryptographicException("The RSA exponent is invalid.");
            if (signature == null || signature.Length != modulus.Length) return false;

            RSAParameters parameters = new RSAParameters { Modulus = modulus, Exponent = exponent };
            using (RSACryptoServiceProvider provider = new RSACryptoServiceProvider())
            {
                provider.PersistKeyInCsp = false;
                provider.ImportParameters(parameters);
                return provider.VerifyData(contents, CryptoConfig.MapNameToOID("SHA256"), signature);
            }
        }
    }

    public sealed class ExtractedTree
    {
        public int FileCount { get; internal set; }
        public long Bytes { get; internal set; }
        public string TreeSha256 { get; internal set; }
    }

    public static class SafeZip
    {
        private const long MaxArchive = 512L * 1024 * 1024;
        private const int MaxEntries = 10000;
        private const long MaxCompressed = 128L * 1024 * 1024;
        private const long MaxEntry = 256L * 1024 * 1024;
        private const long MaxTotal = 1024L * 1024 * 1024;
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

        private sealed class Entry
        {
            internal string Name;
            internal string Relative;
            internal uint Crc;
            internal long Compressed;
            internal long Size;
            internal long LocalOffset;
            internal long DataOffset;
            internal ushort Method;
        }

        private sealed class SliceStream : Stream
        {
            private readonly Stream inner;
            private long remaining;
            internal SliceStream(Stream value, long length) { inner = value; remaining = length; }
            internal long Remaining { get { return remaining; } }
            public override int Read(byte[] buffer, int offset, int count)
            {
                if (remaining == 0) return 0;
                int actual = (int)Math.Min((long)count, remaining);
                int read = inner.Read(buffer, offset, actual);
                if (read <= 0) throw new EndOfStreamException("ZIP entry ended early.");
                remaining -= read;
                return read;
            }
            public override bool CanRead { get { return true; } }
            public override bool CanSeek { get { return false; } }
            public override bool CanWrite { get { return false; } }
            public override long Length { get { throw new NotSupportedException(); } }
            public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
            public override void Flush() { }
            public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
            public override void SetLength(long value) { throw new NotSupportedException(); }
            public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
        }

        private static ushort U16(BinaryReader reader) { return reader.ReadUInt16(); }
        private static uint U32(BinaryReader reader) { return reader.ReadUInt32(); }
        private static void Expect(uint actual, uint expected, string message) { if (actual != expected) throw new InvalidDataException(message); }

        private static bool Reserved(string segment)
        {
            string stem = segment.Split('.')[0];
            string lower = stem.ToLowerInvariant();
            if (lower == "con" || lower == "prn" || lower == "aux" || lower == "nul") return true;
            if (lower.Length == 4 && (lower.StartsWith("com") || lower.StartsWith("lpt")) &&
                ((lower[3] >= '1' && lower[3] <= '9') || lower[3] == '\u00b9' || lower[3] == '\u00b2' || lower[3] == '\u00b3')) return true;
            return false;
        }

        private static string SafeRelative(string name, string root)
        {
            if (String.IsNullOrEmpty(name) || name.Length > 1024 || name.IndexOf('\\') >= 0 || name.IndexOf('\0') >= 0 || name.StartsWith("/", StringComparison.Ordinal) || name.EndsWith("/", StringComparison.Ordinal))
                throw new InvalidDataException("The ZIP path is unsafe.");
            string prefix = root + "/";
            if (!name.StartsWith(prefix, StringComparison.Ordinal)) throw new InvalidDataException("The ZIP root directory does not match.");
            string relative = name.Substring(prefix.Length);
            if (relative.Length == 0) throw new InvalidDataException("The ZIP path is empty after stripping its root.");
            foreach (string segment in relative.Split('/'))
            {
                if (segment.Length == 0 || segment.Length > 255 || segment == "." || segment == ".." || segment.EndsWith(" ", StringComparison.Ordinal) || segment.EndsWith(".", StringComparison.Ordinal) || Reserved(segment))
                    throw new InvalidDataException("The ZIP path is unsafe on Windows.");
                foreach (char value in segment)
                    if (value < 0x20 || value == '<' || value == '>' || value == ':' || value == '"' || value == '|' || value == '?' || value == '*')
                        throw new InvalidDataException("The ZIP path contains an unsafe Windows character.");
            }
            return relative;
        }

        private static void EnsureNoReparse(string path)
        {
            FileAttributes attributes = File.GetAttributes(path);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("A reparse point is not allowed in the staging path.");
        }

        private static uint[] CrcTable()
        {
            uint[] table = new uint[256];
            for (uint index = 0; index < table.Length; index++)
            {
                uint value = index;
                for (int bit = 0; bit < 8; bit++) value = ((value & 1) != 0) ? (0xedb88320U ^ (value >> 1)) : (value >> 1);
                table[index] = value;
            }
            return table;
        }

        private static string Hex(byte[] bytes)
        {
            StringBuilder value = new StringBuilder(bytes.Length * 2);
            foreach (byte item in bytes) value.Append(item.ToString("x2", CultureInfo.InvariantCulture));
            return value.ToString();
        }

        public static ExtractedTree Extract(string archivePath, string destination, string rootDirectory, int expectedCount, long expectedBytes, string expectedTree)
        {
            FileInfo archive = new FileInfo(archivePath);
            if (!archive.Exists || archive.Length <= 0 || archive.Length > MaxArchive) throw new InvalidDataException("The update ZIP size is invalid.");
            if (String.IsNullOrEmpty(rootDirectory) || rootDirectory.IndexOf('/') >= 0 || rootDirectory.IndexOf('\\') >= 0 || rootDirectory == "." || rootDirectory == "..")
                throw new InvalidDataException("The signed ZIP root directory is invalid.");
            DirectoryInfo target = new DirectoryInfo(destination);
            if (!target.Exists || target.GetFileSystemInfos().Length != 0) throw new IOException("The staging directory must be new and empty.");
            EnsureNoReparse(target.FullName);

            List<Entry> entries = new List<Entry>();
            using (FileStream input = new FileStream(archive.FullName, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (BinaryReader reader = new BinaryReader(input, Utf8, true))
            {
                if (input.Length < 22) throw new InvalidDataException("The ZIP end record is missing.");
                input.Position = input.Length - 22;
                Expect(U32(reader), 0x06054b50U, "The ZIP end record is invalid.");
                if (U16(reader) != 0 || U16(reader) != 0) throw new InvalidDataException("Multi-disk ZIP files are not supported.");
                int diskCount = U16(reader);
                int totalCount = U16(reader);
                long centralSize = U32(reader);
                long centralOffset = U32(reader);
                if (U16(reader) != 0 || diskCount != totalCount || totalCount <= 0 || totalCount > MaxEntries || centralOffset + centralSize != input.Length - 22)
                    throw new InvalidDataException("The ZIP central directory is invalid.");
                input.Position = centralOffset;
                long totalBytes = 0;
                HashSet<string> canonicalFiles = new HashSet<string>(StringComparer.Ordinal);
                HashSet<string> canonicalDirectories = new HashSet<string>(StringComparer.Ordinal);
                for (int index = 0; index < totalCount; index++)
                {
                    Expect(U32(reader), 0x02014b50U, "The ZIP central entry is invalid.");
                    U16(reader); U16(reader);
                    ushort flags = U16(reader);
                    ushort method = U16(reader);
                    U16(reader); U16(reader);
                    uint crc = U32(reader);
                    long compressed = U32(reader);
                    long size = U32(reader);
                    int nameLength = U16(reader);
                    int extraLength = U16(reader);
                    int commentLength = U16(reader);
                    int disk = U16(reader);
                    U16(reader);
                    uint external = U32(reader);
                    long localOffset = U32(reader);
                    if (flags != 0x0800 || (method != 0 && method != 8) || nameLength <= 0 || extraLength != 0 || commentLength != 0 || disk != 0 || external != 0x81a40000U)
                        throw new InvalidDataException("The ZIP entry uses unsupported features.");
                    if (compressed > MaxCompressed || size > MaxEntry || (size > 1024 * 1024 && size > Math.Max(1, compressed) * 200L))
                        throw new InvalidDataException("The ZIP entry exceeds its safety limit.");
                    totalBytes = checked(totalBytes + size);
                    if (totalBytes > MaxTotal) throw new InvalidDataException("The ZIP expands beyond its safety limit.");
                    byte[] nameBytes = reader.ReadBytes(nameLength);
                    if (nameBytes.Length != nameLength) throw new EndOfStreamException("The ZIP path ended early.");
                    string name = Utf8.GetString(nameBytes);
                    string relative = SafeRelative(name, rootDirectory);
                    string canonical = relative.Normalize(NormalizationForm.FormC).ToLowerInvariant();
                    if (!canonicalFiles.Add(canonical) || canonicalDirectories.Contains(canonical)) throw new InvalidDataException("The ZIP contains a Windows path collision.");
                    string[] parts = canonical.Split('/');
                    string parent = "";
                    for (int part = 0; part < parts.Length - 1; part++)
                    {
                        parent = parent.Length == 0 ? parts[part] : parent + "/" + parts[part];
                        if (canonicalFiles.Contains(parent)) throw new InvalidDataException("The ZIP contains a file-directory collision.");
                        canonicalDirectories.Add(parent);
                    }
                    entries.Add(new Entry { Name = name, Relative = relative, Crc = crc, Compressed = compressed, Size = size, LocalOffset = localOffset, Method = method });
                }
                if (input.Position != centralOffset + centralSize) throw new InvalidDataException("The ZIP central directory size is invalid.");
                if (entries.Count != expectedCount || totalBytes != expectedBytes) throw new InvalidDataException("The signed unpacked ZIP size does not match.");

                entries.Sort(delegate(Entry left, Entry right) { return left.LocalOffset.CompareTo(right.LocalOffset); });
                long expectedLocal = 0;
                foreach (Entry entry in entries)
                {
                    if (entry.LocalOffset != expectedLocal || entry.LocalOffset < 0 || entry.LocalOffset + 30 > centralOffset)
                        throw new InvalidDataException("The ZIP local entry layout is invalid.");
                    input.Position = entry.LocalOffset;
                    Expect(U32(reader), 0x04034b50U, "The ZIP local entry is invalid.");
                    U16(reader);
                    ushort flags = U16(reader);
                    ushort method = U16(reader);
                    U16(reader); U16(reader);
                    uint crc = U32(reader);
                    long compressed = U32(reader);
                    long size = U32(reader);
                    int nameLength = U16(reader);
                    int extraLength = U16(reader);
                    byte[] localName = reader.ReadBytes(nameLength);
                    string decodedName = Utf8.GetString(localName);
                    if (flags != 0x0800 || method != entry.Method || crc != entry.Crc || compressed != entry.Compressed || size != entry.Size || extraLength != 0 || decodedName != entry.Name)
                        throw new InvalidDataException("The ZIP local and central entries do not match.");
                    entry.DataOffset = input.Position;
                    expectedLocal = checked(entry.DataOffset + entry.Compressed);
                    if (expectedLocal > centralOffset) throw new InvalidDataException("The ZIP entry data is out of bounds.");
                }
                if (expectedLocal != centralOffset) throw new InvalidDataException("The ZIP contains unreferenced local data.");

                entries.Sort(delegate(Entry left, Entry right) { return StringComparer.Ordinal.Compare(left.Relative, right.Relative); });
                StringBuilder tree = new StringBuilder();
                uint[] crcTable = CrcTable();
                foreach (Entry entry in entries)
                {
                    string outputPath = Path.GetFullPath(Path.Combine(target.FullName, entry.Relative.Replace('/', Path.DirectorySeparatorChar)));
                    string prefix = target.FullName.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
                    if (!outputPath.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("The ZIP escaped the staging directory.");
                    string parentPath = Path.GetDirectoryName(outputPath);
                    Directory.CreateDirectory(parentPath);
                    string check = parentPath;
                    while (check.Length >= target.FullName.Length)
                    {
                        EnsureNoReparse(check);
                        if (String.Equals(check, target.FullName, StringComparison.OrdinalIgnoreCase)) break;
                        check = Path.GetDirectoryName(check);
                    }
                    input.Position = entry.DataOffset;
                    SliceStream slice = new SliceStream(input, entry.Compressed);
                    Stream decoded = entry.Method == 0 ? (Stream)slice : new DeflateStream(slice, CompressionMode.Decompress, true);
                    long written = 0;
                    uint actualCrc = 0xffffffffU;
                    byte[] digest;
                    using (SHA256 hash = SHA256.Create())
                    using (FileStream output = new FileStream(outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.WriteThrough))
                    {
                        byte[] buffer = new byte[65536];
                        while (true)
                        {
                            int read = decoded.Read(buffer, 0, buffer.Length);
                            if (read <= 0) break;
                            written = checked(written + read);
                            if (written > entry.Size || written > MaxEntry) throw new InvalidDataException("The ZIP entry expanded beyond its declared size.");
                            for (int i = 0; i < read; i++) actualCrc = (actualCrc >> 8) ^ crcTable[(actualCrc ^ buffer[i]) & 0xff];
                            hash.TransformBlock(buffer, 0, read, null, 0);
                            output.Write(buffer, 0, read);
                        }
                        hash.TransformFinalBlock(new byte[0], 0, 0);
                        digest = hash.Hash;
                        output.Flush(true);
                    }
                    if (entry.Method == 8) decoded.Dispose();
                    if (written != entry.Size || slice.Remaining != 0 || (actualCrc ^ 0xffffffffU) != entry.Crc)
                        throw new InvalidDataException("The ZIP entry integrity check failed.");
                    tree.Append(Hex(digest)).Append("  ").Append(written.ToString(CultureInfo.InvariantCulture)).Append("  ").Append(entry.Relative).Append('\n');
                }
                byte[] treeHash;
                using (SHA256 hash = SHA256.Create()) treeHash = hash.ComputeHash(Utf8.GetBytes(tree.ToString()));
                string actualTree = Hex(treeHash);
                if (!String.Equals(actualTree, expectedTree, StringComparison.Ordinal)) throw new InvalidDataException("The signed unpacked tree hash does not match.");
                return new ExtractedTree { FileCount = entries.Count, Bytes = totalBytes, TreeSha256 = actualTree };
            }
        }
    }
}
'@

try { Add-Type -TypeDefinition $supportSource -Language CSharp -ReferencedAssemblies @("System.IO.Compression.dll") }
catch { Write-WorkerLog "Worker initialization failed: $($_.Exception.GetType().Name): $($_.Exception.Message)"; exit 8 }

function Get-UpdateDirectory {
    $directory = Join-Path ([IO.Path]::GetFullPath($StateDirectory)) "app-update"
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    if (([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw [IO.IOException]::new("The update state directory must not be a reparse point.")
    }
    return $directory
}

function Enter-AppUpdateTransactionLock {
    $stateRoot = [IO.Path]::GetFullPath($StateDirectory)
    if (([IO.File]::GetAttributes($stateRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The runtime state directory is unsafe for update locking.") }
    $lockPath = Join-Path ($stateRoot) "app-update.transaction.lock"
    $existingLockEntry = $null
    foreach ($entry in [IO.Directory]::EnumerateFileSystemEntries($stateRoot)) {
        if ([IO.Path]::GetFileName($entry).Equals("app-update.transaction.lock", [StringComparison]::OrdinalIgnoreCase)) { $existingLockEntry = $entry; break }
    }
    if ($null -ne $existingLockEntry) {
        $lockAttributes = [IO.File]::GetAttributes($existingLockEntry)
        if (($lockAttributes -band [IO.FileAttributes]::Directory) -ne 0) { throw [IO.IOException]::new("The update transaction lock path is occupied by a directory; run state repair.") }
        if (($lockAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The update transaction lock path must not be a reparse point.") }
    }
    $stream = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1, [IO.FileOptions]::WriteThrough)
    if (([IO.File]::GetAttributes($lockPath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $stream.Dispose(); throw [IO.IOException]::new("The update transaction lock path must not be a reparse point.") }
    return $stream
}

function Exit-AppUpdateTransactionLock {
    param([object]$Lock)
    if ($null -ne $Lock) { try { $Lock.Dispose() } catch { } }
}

function Get-StatusPath { return Join-Path (Get-UpdateDirectory) "status.json" }
function Get-CandidatePath { return Join-Path (Get-UpdateDirectory) "candidate.json" }
function Get-PendingPath { return Join-Path (Get-UpdateDirectory) "pending.json" }

function Write-AtomicBytes {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][byte[]]$Bytes)
    $directory = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    $temporary = Join-Path $directory ("." + [IO.Path]::GetFileName($Path) + "." + [Guid]::NewGuid().ToString("N") + ".tmp")
    $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    try {
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
    try {
        if ([IO.File]::Exists($Path)) {
            $backup = Join-Path $directory ("." + [IO.Path]::GetFileName($Path) + "." + [Guid]::NewGuid().ToString("N") + ".bak")
            try { [IO.File]::Replace($temporary, $Path, $backup, $true) } finally { if ([IO.File]::Exists($backup)) { [IO.File]::Delete($backup) } }
        }
        else { [IO.File]::Move($temporary, $Path) }
    } finally {
        if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
    }
}

function Write-AtomicJson {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][object]$Value)
    $json = ConvertTo-Json -InputObject $Value -Compress -Depth 12
    Write-AtomicBytes -Path $Path -Bytes $utf8.GetBytes($json)
}

function Write-Status {
    param([Parameter(Mandatory = $true)][object]$Value)
    Write-AtomicJson -Path (Get-StatusPath) -Value $Value
}

function Write-ErrorStatus {
    param([ValidateSet("CHECK", "STAGE")][string]$Operation, [string]$CurrentVersion, [string]$Code, [string]$Message)
    if ([string]::IsNullOrWhiteSpace($CurrentVersion) -or $CurrentVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { $CurrentVersion = "0.0.0" }
    Write-Status ([ordered]@{
        state = "ERROR"
        currentVersion = $CurrentVersion
        operation = $Operation
        code = $Code
        message = $Message
    })
}

function Invoke-TestStageCrash {
    param([ValidateSet("DOWNLOAD", "EXTRACTED")][string]$Phase)
    if (($AllowTestHttpLoopback -or $env:TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP -ceq "1") -and $env:TARKOV_HELPER_UPDATE_TEST_STAGE_CRASH_PHASE -ceq $Phase) {
        # Test-only hard stop. Environment.Exit bypasses finally and models a
        # power loss while the worker owns a partially staged package.
        [Environment]::Exit(98)
    }
}

function Get-ExactPropertyNames {
    param([object]$Value)
    if ($null -eq $Value -or $Value -isnot [psobject] -or $Value -is [string]) { return @() }
    return @($Value.PSObject.Properties | Where-Object { $_.MemberType -in @("NoteProperty", "Property") } | ForEach-Object { $_.Name })
}

function Assert-ExactObject {
    param([object]$Value, [string[]]$Properties, [string]$Label)
    $actual = @(Get-ExactPropertyNames -Value $Value)
    if ($actual.Count -ne $Properties.Count) { throw [IO.InvalidDataException]::new("$Label has an invalid shape.") }
    foreach ($property in $Properties) {
        if (-not ($actual -ccontains $property)) { throw [IO.InvalidDataException]::new("$Label has an invalid shape.") }
    }
}

function Read-StrictJsonFile {
    param([Parameter(Mandatory = $true)][string]$Path, [ValidateRange(1, 536870912)][int]$MaximumBytes)
    $file = [IO.FileInfo]::new([IO.Path]::GetFullPath($Path))
    if (-not $file.Exists -or $file.Length -le 0 -or $file.Length -gt $MaximumBytes) { throw [IO.InvalidDataException]::new("The JSON file size is invalid.") }
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    $text = [TarkovHelperUpdateSupport.StrictJson]::DecodeAndValidate($bytes)
    return $text | ConvertFrom-Json
}

function ConvertFrom-StrictJsonBytes {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $text = [TarkovHelperUpdateSupport.StrictJson]::DecodeAndValidate($Bytes)
    return $text | ConvertFrom-Json
}

function Get-Sha256Hex {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Get-FileSha256Hex {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::OpenRead([IO.Path]::GetFullPath($Path))
    try {
        $hash = [Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace("-", "").ToLowerInvariant() }
        finally { $hash.Dispose() }
    } finally {
        $stream.Dispose()
    }
}

function Test-SafeInteger {
    param([object]$Value, [long]$Minimum = 0, [long]$Maximum = 9007199254740991)
    if ($Value -isnot [byte] -and $Value -isnot [int16] -and $Value -isnot [int32] -and $Value -isnot [int64] -and $Value -isnot [decimal]) { return $false }
    try {
        $number = [decimal]$Value
        return [decimal]::Truncate($number) -eq $number -and $number -ge $Minimum -and $number -le $Maximum
    } catch { return $false }
}

function Test-StableVersion {
    param([object]$Value)
    if ($Value -isnot [string] -or $Value.Length -gt 64 -or $Value -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { return $false }
    foreach ($part in $Value.Split('.')) {
        [long]$parsed = 0
        if (-not [long]::TryParse($part, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsed) -or $parsed -gt 9007199254740991) { return $false }
    }
    return $true
}

function Compare-StableVersion {
    param([string]$Left, [string]$Right)
    $leftParts = @($Left.Split('.') | ForEach-Object { [decimal]::Parse($_, [Globalization.CultureInfo]::InvariantCulture) })
    $rightParts = @($Right.Split('.') | ForEach-Object { [decimal]::Parse($_, [Globalization.CultureInfo]::InvariantCulture) })
    for ($index = 0; $index -lt 3; $index++) {
        if ($leftParts[$index] -lt $rightParts[$index]) { return -1 }
        if ($leftParts[$index] -gt $rightParts[$index]) { return 1 }
    }
    return 0
}

function Get-CurrentVersionDocument {
    $path = Join-Path ([IO.Path]::GetFullPath($PackageRoot)) "app\version.json"
    $value = Read-StrictJsonFile -Path $path -MaximumBytes 8192
    Assert-ExactObject -Value $value -Properties @("schemaVersion", "product", "version", "commit", "updaterProtocolVersion") -Label "app/version.json"
    if ($value.schemaVersion -ne 1 -or $value.product -cne "tarkov-helper-web" -or -not (Test-StableVersion $value.version) -or $value.commit -isnot [string] -or $value.commit -notmatch '^[0-9a-f]{40}$' -or $value.updaterProtocolVersion -ne 1) {
        throw [IO.InvalidDataException]::new("app/version.json is invalid.")
    }
    return $value
}

function Get-UpdateConfiguration {
    $path = Join-Path ([IO.Path]::GetFullPath($PackageRoot)) "UPDATE_CONFIG.json"
    $value = Read-StrictJsonFile -Path $path -MaximumBytes 65536
    if ($value.updaterEnabled -ceq $false) {
        Assert-ExactObject -Value $value -Properties @("schemaVersion", "updaterEnabled", "protocolVersion") -Label "UPDATE_CONFIG.json"
        if ($value.schemaVersion -ne 1 -or $value.protocolVersion -ne 1) { throw [IO.InvalidDataException]::new("UPDATE_CONFIG.json is invalid.") }
        return $value
    }
    Assert-ExactObject -Value $value -Properties @("schemaVersion", "updaterEnabled", "protocolVersion", "repository", "releaseApi", "manifestAsset", "signatureAsset", "requireImmutableRelease", "signing") -Label "UPDATE_CONFIG.json"
    Assert-ExactObject -Value $value.signing -Properties @("algorithm", "keyId", "publicKeySpkiPem") -Label "UPDATE_CONFIG.json signing"
    if ($value.schemaVersion -ne 1 -or $value.updaterEnabled -cne $true -or $value.protocolVersion -ne 1 -or $value.repository -isnot [string] -or $value.repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $value.manifestAsset -cne "update-manifest-v1.json" -or $value.signatureAsset -cne "update-manifest-v1.sig" -or $value.requireImmutableRelease -cne $true -or $value.signing.algorithm -cne "RSA-SHA256" -or $value.signing.keyId -isnot [string] -or $value.signing.keyId -notmatch '^sha256:[0-9a-f]{64}$' -or $value.signing.publicKeySpkiPem -isnot [string]) {
        throw [IO.InvalidDataException]::new("UPDATE_CONFIG.json is invalid.")
    }
    $expectedReleaseApi = "https://api.github.com/repos/$($value.repository)/releases/latest"
    if ($AllowTestHttpLoopback -or $env:TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP -ceq "1") {
        $uri = [Uri]$value.releaseApi
        if (-not $uri.IsAbsoluteUri -or $uri.Scheme -cne "http" -or $uri.Host -cne "127.0.0.1" -or -not $uri.AbsolutePath.EndsWith("/repos/$($value.repository)/releases/latest", [StringComparison]::Ordinal)) {
            throw [IO.InvalidDataException]::new("The test release API is invalid.")
        }
    } elseif ($value.releaseApi -cne $expectedReleaseApi) {
        throw [IO.InvalidDataException]::new("The release API does not match the pinned repository.")
    }
    return $value
}

function Get-RandomIdentifier {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Test-AllowedDownloadUri {
    param([Uri]$Uri, [Uri]$ReleaseApi)
    if ($AllowTestHttpLoopback -or $env:TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP -ceq "1") {
        return $Uri.IsAbsoluteUri -and $Uri.Scheme -ceq "http" -and $Uri.Host -ceq "127.0.0.1" -and $Uri.Port -eq $ReleaseApi.Port
    }
    if (-not $Uri.IsAbsoluteUri -or $Uri.Scheme -cne "https" -or -not $Uri.IsDefaultPort -or -not [string]::IsNullOrEmpty($Uri.UserInfo)) { return $false }
    return $Uri.Host -cin @("api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com")
}

function Get-UpdateRetryDelayMilliseconds {
    param([Net.HttpWebResponse]$Response, [int]$Attempt)
    $override = 0
    if ([int]::TryParse([string]$env:TARKOV_HELPER_UPDATE_TEST_RETRY_DELAY_MS, [ref]$override) -and $override -ge 0 -and $override -le 30000) {
        return [Math]::Min(30000, $override * [Math]::Pow(2, $Attempt))
    }
    $retryAfter = 0
    if ($null -ne $Response -and [int]::TryParse([string]$Response.Headers["Retry-After"], [ref]$retryAfter) -and $retryAfter -ge 0) {
        return [Math]::Min(30000, $retryAfter * 1000)
    }
    return [Math]::Min(30000, 1000 * [Math]::Pow(2, $Attempt))
}

function Test-TransientUpdateStatus {
    param([int]$Status)
    return $Status -in @(408, 425, 500, 502, 503, 504)
}

function Invoke-BoundedDownload {
    param(
        [Parameter(Mandatory = $true)][Uri]$Uri,
        [Parameter(Mandatory = $true)][Uri]$ReleaseApi,
        [ValidateRange(1, 536870912)][int]$MaximumBytes,
        [long]$ExpectedBytes = -1,
        [string]$ExpectedDigest,
        [string]$Destination,
        [string]$Accept = "application/octet-stream",
        [scriptblock]$Progress
    )
    $current = $Uri
    $redirect = 0
    $retryAttempt = 0
    while ($redirect -le 5) {
        if (-not (Test-AllowedDownloadUri -Uri $current -ReleaseApi $ReleaseApi)) { throw [Net.WebException]::new("The update download URI is not allowed.") }
        $request = [Net.HttpWebRequest]::Create($current)
        if ($AllowTestHttpLoopback -or $env:TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP -ceq "1") {
            $request.Proxy = $null
        } else {
            # Respect a user's Windows/enterprise proxy. The URI allow-list above
            # still prevents redirects to arbitrary hosts, so proxy support does
            # not widen the updater's trust boundary.
            $request.Proxy = [Net.WebRequest]::DefaultWebProxy
            if ($null -ne $request.Proxy -and $null -eq $request.Proxy.Credentials) {
                $request.Proxy.Credentials = [Net.CredentialCache]::DefaultCredentials
            }
        }
        $request.AllowAutoRedirect = $false
        $request.KeepAlive = $false
        $request.Timeout = 30000
        $request.ReadWriteTimeout = 30000
        $request.Method = "GET"
        $request.Accept = $Accept
        $request.UserAgent = "TarkovHelperWebUpdater/1"
        $request.Headers["X-GitHub-Api-Version"] = "2022-11-28"
        $response = $null
        try {
            try { $response = [Net.HttpWebResponse]$request.GetResponse() }
            catch [Net.WebException] {
                if ($null -ne $_.Exception.Response) { $response = [Net.HttpWebResponse]$_.Exception.Response }
                elseif ($retryAttempt -lt 2 -and $_.Exception.Status -in @([Net.WebExceptionStatus]::ConnectFailure, [Net.WebExceptionStatus]::ConnectionClosed, [Net.WebExceptionStatus]::NameResolutionFailure, [Net.WebExceptionStatus]::Timeout)) {
                    $delay = Get-UpdateRetryDelayMilliseconds -Response $null -Attempt $retryAttempt
                    $retryAttempt += 1
                    Start-Sleep -Milliseconds $delay
                    continue
                } else { throw }
            }
            $status = [int]$response.StatusCode
            if ($status -in @(301, 302, 303, 307, 308)) {
                if ($redirect -eq 5) { throw [Net.WebException]::new("The update download redirected too many times.") }
                $location = $response.Headers["Location"]
                if ([string]::IsNullOrWhiteSpace($location)) { throw [Net.WebException]::new("The update redirect is missing its destination.") }
                $current = [Uri]::new($current, $location)
                $redirect += 1
                $retryAttempt = 0
                continue
            }
            if ($status -ne 200) {
                if (Test-TransientUpdateStatus -Status $status -and $retryAttempt -lt 2) {
                    $delay = Get-UpdateRetryDelayMilliseconds -Response $response -Attempt $retryAttempt
                    $retryAttempt += 1
                    Start-Sleep -Milliseconds $delay
                    continue
                }
                $diagnostics = @("The update server returned HTTP $status.")
                foreach ($header in @("X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After")) {
                    $value = $response.Headers[$header]
                    if (-not [string]::IsNullOrWhiteSpace($value)) { $diagnostics += "$header=$value" }
                }
                throw [Net.WebException]::new(($diagnostics -join " "))
            }
            $retryAttempt = 0
            if ($response.ContentLength -gt $MaximumBytes -or ($ExpectedBytes -ge 0 -and $response.ContentLength -ge 0 -and $response.ContentLength -ne $ExpectedBytes)) {
                throw [IO.InvalidDataException]::new("The update download length is invalid.")
            }
            $memory = $null
            $output = $null
            if ([string]::IsNullOrWhiteSpace($Destination)) { $memory = [IO.MemoryStream]::new() }
            else { $output = [IO.FileStream]::new($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 65536, [IO.FileOptions]::WriteThrough) }
            $hash = [Security.Cryptography.SHA256]::Create()
            $input = $response.GetResponseStream()
            $total = [long]0
            try {
                $buffer = New-Object byte[] 65536
                while ($true) {
                    $read = $input.Read($buffer, 0, $buffer.Length)
                    if ($read -le 0) { break }
                    $total += $read
                    if ($total -gt $MaximumBytes -or ($ExpectedBytes -ge 0 -and $total -gt $ExpectedBytes)) { throw [IO.InvalidDataException]::new("The update download exceeded its size limit.") }
                    $null = $hash.TransformBlock($buffer, 0, $read, $null, 0)
                    if ($null -ne $output) { $output.Write($buffer, 0, $read) } else { $memory.Write($buffer, 0, $read) }
                    if ($null -ne $Progress) { & $Progress $total }
                }
                $null = $hash.TransformFinalBlock((New-Object byte[] 0), 0, 0)
                if ($ExpectedBytes -ge 0 -and $total -ne $ExpectedBytes) { throw [IO.InvalidDataException]::new("The update download was truncated.") }
                $actualDigest = "sha256:" + ([BitConverter]::ToString($hash.Hash)).Replace("-", "").ToLowerInvariant()
                if (-not [string]::IsNullOrWhiteSpace($ExpectedDigest) -and $actualDigest -cne $ExpectedDigest) { throw [Security.Cryptography.CryptographicException]::new("The GitHub asset digest does not match.") }
                if ($null -ne $output) { $output.Flush($true); return [pscustomobject]@{ Bytes = $total; Digest = $actualDigest; Path = $Destination } }
                return [pscustomobject]@{ Bytes = $total; Digest = $actualDigest; Contents = $memory.ToArray() }
            } finally {
                $input.Dispose()
                $hash.Dispose()
                if ($null -ne $output) { $output.Dispose() }
                if ($null -ne $memory) { $memory.Dispose() }
            }
        } finally {
            if ($null -ne $response) { $response.Dispose() }
        }
    }
}

function Get-ReleaseUri {
    param([object]$Configuration, [long]$ReleaseId = 0)
    $latest = [Uri]$Configuration.releaseApi
    if ($ReleaseId -le 0) { return $latest }
    $builder = [UriBuilder]::new($latest)
    $builder.Path = $latest.AbsolutePath.Substring(0, $latest.AbsolutePath.Length - "/latest".Length) + "/$ReleaseId"
    $builder.Query = ""
    $builder.Fragment = ""
    return $builder.Uri
}

function Get-AssetUri {
    param([object]$Configuration, [long]$AssetId)
    $latest = [Uri]$Configuration.releaseApi
    $marker = "/releases/latest"
    if (-not $latest.AbsolutePath.EndsWith($marker, [StringComparison]::Ordinal)) { throw [IO.InvalidDataException]::new("The release API path is invalid.") }
    $builder = [UriBuilder]::new($latest)
    $builder.Path = $latest.AbsolutePath.Substring(0, $latest.AbsolutePath.Length - $marker.Length) + "/releases/assets/$AssetId"
    $builder.Query = ""
    $builder.Fragment = ""
    return $builder.Uri
}

function Read-ReleaseDocument {
    param([object]$Configuration, [long]$ReleaseId = 0)
    $releaseUri = Get-ReleaseUri -Configuration $Configuration -ReleaseId $ReleaseId
    $download = Invoke-BoundedDownload -Uri $releaseUri -ReleaseApi ([Uri]$Configuration.releaseApi) `
        -MaximumBytes $maximumReleaseBytes -Accept "application/vnd.github+json"
    $release = ConvertFrom-StrictJsonBytes -Bytes $download.Contents
    if (
        -not (Test-SafeInteger -Value $release.id -Minimum 1) -or
        $release.draft -cne $false -or
        $release.prerelease -cne $false -or
        $release.immutable -cne $true -or
        $release.tag_name -isnot [string] -or
        $release.tag_name -notmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or
        $release.html_url -isnot [string] -or
        $release.published_at -isnot [string] -or
        $release.assets -isnot [array]
    ) {
        throw [IO.InvalidDataException]::new("The GitHub release is not an immutable stable release.")
    }
    if ($ReleaseId -gt 0 -and [long]$release.id -ne $ReleaseId) { throw [IO.InvalidDataException]::new("The GitHub release identifier changed.") }
    $version = $release.tag_name.Substring(1)
    if (-not (Test-StableVersion $version)) { throw [IO.InvalidDataException]::new("The GitHub release version is invalid.") }
    $expectedPage = "https://github.com/$($Configuration.repository)/releases/tag/v$version"
    if ($release.html_url -cne $expectedPage) { throw [IO.InvalidDataException]::new("The GitHub release page does not match the pinned repository.") }
    [DateTimeOffset]$published = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse($release.published_at, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$published)) {
        throw [IO.InvalidDataException]::new("The GitHub release publication time is invalid.")
    }
    return [pscustomobject]@{ Document = $release; Version = $version; PublishedAt = $published.UtcDateTime.ToString("o", [Globalization.CultureInfo]::InvariantCulture) }
}

function Get-ReleaseAsset {
    param([object]$Release, [object]$Configuration, [string]$Name, [long]$AssetId = 0, [int]$MaximumBytes = 536870912)
    $matches = @($Release.assets | Where-Object {
        if ($_.name -isnot [string] -or $_.name -cne $Name) { return $false }
        if ($AssetId -le 0) { return $true }
        return (Test-SafeInteger -Value $_.id -Minimum 1) -and [long]$_.id -eq $AssetId
    })
    if ($matches.Count -ne 1) { throw [IO.InvalidDataException]::new("The required GitHub release asset is missing or duplicated.") }
    $asset = $matches[0]
    if (
        -not (Test-SafeInteger -Value $asset.id -Minimum 1) -or
        $asset.name -isnot [string] -or
        $asset.state -cne "uploaded" -or
        -not (Test-SafeInteger -Value $asset.size -Minimum 1 -Maximum $MaximumBytes) -or
        $asset.digest -isnot [string] -or
        $asset.digest -notmatch '^sha256:[0-9a-f]{64}$' -or
        $asset.url -isnot [string]
    ) {
        throw [IO.InvalidDataException]::new("The GitHub release asset metadata is invalid.")
    }
    $expectedUri = Get-AssetUri -Configuration $Configuration -AssetId ([long]$asset.id)
    if ($asset.url -cne $expectedUri.AbsoluteUri) { throw [IO.InvalidDataException]::new("The GitHub asset URL is not bound to its identifier.") }
    return $asset
}

function Assert-UnpackedRecord {
    param([object]$Value, [string]$Label)
    Assert-ExactObject -Value $Value -Properties @("fileCount", "bytes", "treeSha256") -Label $Label
    if (-not (Test-SafeInteger $Value.fileCount 1 10000) -or -not (Test-SafeInteger $Value.bytes 1 1073741824) -or $Value.treeSha256 -isnot [string] -or $Value.treeSha256 -notmatch '^[0-9a-f]{64}$') {
        throw [IO.InvalidDataException]::new("$Label is invalid.")
    }
}

function Assert-ArtifactRecord {
    param([object]$Value, [string]$Kind, [string]$Version, [string]$Commit)
    $properties = @("assetId", "filename", "format", "bytes", "sha256", "rootDirectory", "stripComponents", "unpacked")
    if ($Kind -eq "direct") { $properties += "package" }
    if ($Kind -eq "source") { $properties += "commit" }
    Assert-ExactObject -Value $Value -Properties $properties -Label "$Kind artifact"
    if (
        -not (Test-SafeInteger $Value.assetId 1) -or
        $Value.filename -isnot [string] -or $Value.filename.Length -gt 200 -or $Value.filename -notmatch '^[A-Za-z0-9._-]+\.zip$' -or
        $Value.format -cne "zip" -or
        -not (Test-SafeInteger $Value.bytes 1 $maximumArchiveBytes) -or
        $Value.sha256 -isnot [string] -or $Value.sha256 -notmatch '^[0-9a-f]{64}$' -or
        $Value.rootDirectory -isnot [string] -or $Value.rootDirectory.Length -lt 1 -or $Value.rootDirectory.Length -gt 255 -or
        $Value.rootDirectory -match '[\\/:*?"<>|\x00-\x1f]' -or $Value.rootDirectory -match '[ .]$' -or $Value.rootDirectory -in @(".", "..") -or
        $Value.stripComponents -ne 1
    ) {
        throw [IO.InvalidDataException]::new("The $Kind artifact is invalid.")
    }
    Assert-UnpackedRecord -Value $Value.unpacked -Label "$Kind unpacked record"
    if ($Kind -eq "direct") {
        Assert-ExactObject -Value $Value.package -Properties @("version", "sourceCommit", "updaterProtocolVersion", "appFiles", "appBytes", "appTreeSha256") -Label "direct package record"
        if (
            $Value.package.version -cne $Version -or $Value.package.sourceCommit -cne $Commit -or $Value.package.updaterProtocolVersion -ne 1 -or
            -not (Test-SafeInteger $Value.package.appFiles 1 10000) -or -not (Test-SafeInteger $Value.package.appBytes 1 1073741824) -or
            $Value.package.appTreeSha256 -isnot [string] -or $Value.package.appTreeSha256 -notmatch '^[0-9a-f]{64}$'
        ) { throw [IO.InvalidDataException]::new("The direct package record is invalid.") }
    }
    if ($Kind -eq "source" -and $Value.commit -cne $Commit) { throw [IO.InvalidDataException]::new("The source artifact commit is invalid.") }
}

function Assert-SignedManifest {
    param([byte[]]$ManifestBytes, [byte[]]$SignatureBytes, [object]$Configuration, [object]$ReleaseRecord)
    if (-not [TarkovHelperUpdateSupport.RsaManifest]::Verify($ManifestBytes, $SignatureBytes, [string]$Configuration.signing.publicKeySpkiPem, [string]$Configuration.signing.keyId)) {
        throw [Security.Cryptography.CryptographicException]::new("The update manifest signature is invalid.")
    }
    $manifest = ConvertFrom-StrictJsonBytes -Bytes $ManifestBytes
    Assert-ExactObject -Value $manifest -Properties @("schemaVersion", "product", "channel", "repository", "version", "tag", "commit", "createdAt", "releaseId", "updater", "artifacts") -Label "update manifest"
    Assert-ExactObject -Value $manifest.updater -Properties @("protocolVersion", "configFile", "manifestAsset", "signatureAsset", "requireImmutableRelease", "signing") -Label "update manifest updater"
    Assert-ExactObject -Value $manifest.updater.signing -Properties @("algorithm", "keyId") -Label "update manifest signing"
    Assert-ExactObject -Value $manifest.artifacts -Properties @("direct", "static", "source") -Label "update manifest artifacts"
    if (
        $manifest.schemaVersion -ne 1 -or $manifest.product -cne "tarkov-helper-web" -or $manifest.channel -cne "stable" -or
        $manifest.repository -cne $Configuration.repository -or -not (Test-StableVersion $manifest.version) -or
        $manifest.tag -cne ("v" + $manifest.version) -or $manifest.commit -isnot [string] -or $manifest.commit -notmatch '^[0-9a-f]{40}$' -or
        -not (Test-SafeInteger $manifest.releaseId 1) -or [long]$manifest.releaseId -ne [long]$ReleaseRecord.Document.id -or
        $manifest.version -cne $ReleaseRecord.Version -or
        $manifest.updater.protocolVersion -ne 1 -or $manifest.updater.configFile -cne "UPDATE_CONFIG.json" -or
        $manifest.updater.manifestAsset -cne $Configuration.manifestAsset -or $manifest.updater.signatureAsset -cne $Configuration.signatureAsset -or
        $manifest.updater.requireImmutableRelease -cne $true -or $manifest.updater.signing.algorithm -cne "RSA-SHA256" -or
        $manifest.updater.signing.keyId -cne $Configuration.signing.keyId
    ) { throw [IO.InvalidDataException]::new("The signed update manifest does not match the pinned release.") }
    [DateTimeOffset]$created = [DateTimeOffset]::MinValue
    if ($manifest.createdAt -isnot [string] -or -not [DateTimeOffset]::TryParse($manifest.createdAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$created)) {
        throw [IO.InvalidDataException]::new("The signed update manifest time is invalid.")
    }
    Assert-ArtifactRecord -Value $manifest.artifacts.direct -Kind "direct" -Version $manifest.version -Commit $manifest.commit
    Assert-ArtifactRecord -Value $manifest.artifacts.static -Kind "static" -Version $manifest.version -Commit $manifest.commit
    Assert-ArtifactRecord -Value $manifest.artifacts.source -Kind "source" -Version $manifest.version -Commit $manifest.commit
    $ids = @([long]$manifest.artifacts.direct.assetId, [long]$manifest.artifacts.static.assetId, [long]$manifest.artifacts.source.assetId)
    if (@($ids | Select-Object -Unique).Count -ne 3) { throw [IO.InvalidDataException]::new("The signed artifact identifiers are not unique.") }
    return $manifest
}

function Get-VerifiedReleaseCandidate {
    param([object]$Configuration, [object]$CurrentVersion, [long]$ReleaseId = 0)
    $release = Read-ReleaseDocument -Configuration $Configuration -ReleaseId $ReleaseId
    $manifestAsset = Get-ReleaseAsset -Release $release.Document -Configuration $Configuration -Name $Configuration.manifestAsset -MaximumBytes $maximumManifestBytes
    $signatureAsset = Get-ReleaseAsset -Release $release.Document -Configuration $Configuration -Name $Configuration.signatureAsset -MaximumBytes $maximumSignatureBytes
    $manifestDownload = Invoke-BoundedDownload -Uri ([Uri]$manifestAsset.url) -ReleaseApi ([Uri]$Configuration.releaseApi) `
        -MaximumBytes $maximumManifestBytes -ExpectedBytes ([long]$manifestAsset.size) -ExpectedDigest ([string]$manifestAsset.digest)
    $signatureDownload = Invoke-BoundedDownload -Uri ([Uri]$signatureAsset.url) -ReleaseApi ([Uri]$Configuration.releaseApi) `
        -MaximumBytes $maximumSignatureBytes -ExpectedBytes ([long]$signatureAsset.size) -ExpectedDigest ([string]$signatureAsset.digest)
    $manifest = Assert-SignedManifest -ManifestBytes $manifestDownload.Contents -SignatureBytes $signatureDownload.Contents -Configuration $Configuration -ReleaseRecord $release
    $direct = $manifest.artifacts.direct
    $directAsset = Get-ReleaseAsset -Release $release.Document -Configuration $Configuration -Name $direct.filename -AssetId ([long]$direct.assetId) -MaximumBytes $maximumArchiveBytes
    if ([long]$directAsset.size -ne [long]$direct.bytes -or $directAsset.digest -cne ("sha256:" + $direct.sha256)) {
        throw [IO.InvalidDataException]::new("The signed direct package does not match its GitHub asset digest.")
    }
    return [pscustomobject]@{
        Release = $release
        Manifest = $manifest
        ManifestBytes = $manifestDownload.Contents
        SignatureBytes = $signatureDownload.Contents
        DirectAsset = $directAsset
        ManifestSha256 = (Get-Sha256Hex $manifestDownload.Contents)
    }
}

function Test-SafePackageRelativePath {
    param([string]$RelativePath)
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or $RelativePath.Length -gt 1024 -or $RelativePath.Contains('\') -or $RelativePath.StartsWith('/') -or $RelativePath.EndsWith('/')) { return $false }
    foreach ($segment in $RelativePath.Split('/')) {
        if ([string]::IsNullOrEmpty($segment) -or $segment -in @('.', '..') -or $segment.Length -gt 255 -or $segment -match '[\x00-\x1f<>:"|?*]' -or $segment -match '[ .]$' -or $segment -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') { return $false }
    }
    return $true
}

function Assert-InternalChecksums {
    param([string]$StageRoot)
    $checksumPath = Join-Path $StageRoot "SHA256SUMS.txt"
    $bytes = [IO.File]::ReadAllBytes($checksumPath)
    if ($bytes.Length -le 0 -or $bytes.Length -gt 10MB) { throw [IO.InvalidDataException]::new("SHA256SUMS.txt is invalid.") }
    $contents = $utf8.GetString($bytes)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) { throw [IO.InvalidDataException]::new("SHA256SUMS.txt must not contain a BOM.") }
    if (-not $contents.EndsWith("`n", [StringComparison]::Ordinal)) { throw [IO.InvalidDataException]::new("SHA256SUMS.txt must end with LF.") }
    $expected = New-Object 'Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
    foreach ($rawLine in $contents.Substring(0, $contents.Length - 1).Split("`n")) {
        $line = if ($rawLine.EndsWith("`r")) { $rawLine.Substring(0, $rawLine.Length - 1) } else { $rawLine }
        $match = [Text.RegularExpressions.Regex]::Match($line, '^([0-9a-f]{64}) {2}(0|[1-9]\d*) {2}(.+)$')
        if (-not $match.Success -or -not (Test-SafePackageRelativePath $match.Groups[3].Value)) { throw [IO.InvalidDataException]::new("SHA256SUMS.txt contains an invalid record.") }
        [long]$size = 0
        $recordPath = $match.Groups[3].Value
        if (-not [long]::TryParse($match.Groups[2].Value, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$size) -or $size -gt 1073741824 -or $expected.ContainsKey($recordPath)) {
            throw [IO.InvalidDataException]::new("SHA256SUMS.txt contains a duplicate or oversized record.")
        }
        $expected.Add($recordPath, [pscustomobject]@{ sha256 = $match.Groups[1].Value; size = $size })
    }
    $actualCount = 0
    $prefix = $StageRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    foreach ($path in [IO.Directory]::EnumerateFiles($StageRoot, '*', [IO.SearchOption]::AllDirectories)) {
        if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The staged package contains a reparse point.") }
        $relative = $path.Substring($prefix.Length).Replace([IO.Path]::DirectorySeparatorChar, '/')
        if ($relative -ceq 'SHA256SUMS.txt') { continue }
        $record = $null
        if (-not $expected.TryGetValue($relative, [ref]$record)) { throw [IO.InvalidDataException]::new("SHA256SUMS.txt is missing a package file.") }
        $file = [IO.FileInfo]::new($path)
        if ($file.Length -ne [long]$record.size -or (Get-FileSha256Hex $path) -cne [string]$record.sha256) { throw [Security.Cryptography.CryptographicException]::new("An internal package checksum does not match.") }
        $actualCount++
    }
    if ($actualCount -ne $expected.Count) { throw [IO.InvalidDataException]::new("SHA256SUMS.txt contains a file that is not in the package.") }
}

function Assert-StagedPackage {
    param([string]$StageRoot, [object]$Manifest, [object]$CurrentConfiguration)
    foreach ($required in @("launcher.ps1", "app-update-worker.ps1", "app-update-broker.ps1", "Tarkov Helper.exe", "TarkovHelper.ico", "start-menu.ps1", "Tarkov Helper 실행.vbs", "Tarkov Helper 시작 메뉴 등록.vbs", "Tarkov Helper 시작 메뉴 제거.vbs", "Tarkov Helper 종료.vbs", "문제 해결용 실행.cmd", "Tarkov Helper 상태 복구.cmd", "Tarkov Helper 격리 복구 실행.cmd", "사용 안내.txt", "UPDATE_CONFIG.json", "PACKAGE_INFO.txt", "SHA256SUMS.txt", "app\index.html", "app\version.json")) {
        if (-not [IO.File]::Exists((Join-Path $StageRoot $required))) { throw [IO.InvalidDataException]::new("The staged package is missing a required file.") }
    }
    Assert-InternalChecksums -StageRoot $StageRoot
    $newVersion = Read-StrictJsonFile -Path (Join-Path $StageRoot "app\version.json") -MaximumBytes 8192
    Assert-ExactObject -Value $newVersion -Properties @("schemaVersion", "product", "version", "commit", "updaterProtocolVersion") -Label "staged app/version.json"
    if ($newVersion.schemaVersion -ne 1 -or $newVersion.product -cne "tarkov-helper-web" -or $newVersion.version -cne $Manifest.version -or $newVersion.commit -cne $Manifest.commit -or $newVersion.updaterProtocolVersion -ne 1) { throw [IO.InvalidDataException]::new("The staged version identity does not match the signed manifest.") }
    $newConfig = Read-StrictJsonFile -Path (Join-Path $StageRoot "UPDATE_CONFIG.json") -MaximumBytes 65536
    Assert-ExactObject -Value $newConfig -Properties @("schemaVersion", "updaterEnabled", "protocolVersion", "repository", "releaseApi", "manifestAsset", "signatureAsset", "requireImmutableRelease", "signing") -Label "staged UPDATE_CONFIG.json"
    Assert-ExactObject -Value $newConfig.signing -Properties @("algorithm", "keyId", "publicKeySpkiPem") -Label "staged signing configuration"
    foreach ($property in @("schemaVersion", "updaterEnabled", "protocolVersion", "repository", "releaseApi", "manifestAsset", "signatureAsset", "requireImmutableRelease")) {
        if ($newConfig.$property -cne $CurrentConfiguration.$property) { throw [IO.InvalidDataException]::new("The staged update configuration changed a pinned setting.") }
    }
    foreach ($property in @("algorithm", "keyId", "publicKeySpkiPem")) {
        if ($newConfig.signing.$property -cne $CurrentConfiguration.signing.$property) { throw [IO.InvalidDataException]::new("The staged update configuration changed the signing key.") }
    }
    $packageInfo = [IO.File]::ReadAllText((Join-Path $StageRoot "PACKAGE_INFO.txt"), $utf8)
    $package = $Manifest.artifacts.direct.package
    $expectedLines = @(
        "Version: $($package.version)",
        "Source commit: $($package.sourceCommit)",
        "Updater protocol: $($package.updaterProtocolVersion)",
        "App files: $($package.appFiles)",
        "App bytes: $($package.appBytes)",
        "App tree SHA-256: $($package.appTreeSha256)"
    )
    foreach ($line in $expectedLines) { if ($packageInfo -notmatch ('(?m)^' + [Regex]::Escape($line) + '$')) { throw [IO.InvalidDataException]::new("PACKAGE_INFO.txt does not match the signed manifest.") } }
}

function Remove-OwnedStageDirectory {
    param([string]$Path, [string]$ExpectedParent)
    if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Directory]::Exists($Path)) { return }
    $full = [IO.Path]::GetFullPath($Path)
    $parent = [IO.Path]::GetFullPath($ExpectedParent).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $packageLeaf = [IO.Path]::GetFileName([IO.Path]::GetFullPath($PackageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar))
    $stagePattern = '^\.' + [Regex]::Escape($packageLeaf) + '\.update-stage-[A-Za-z0-9_-]{40,64}$'
    $info = [IO.DirectoryInfo]::new($full)
    if ($null -eq $info.Parent -or -not $info.Parent.FullName.Equals($parent, [StringComparison]::OrdinalIgnoreCase) -or $info.Name -notmatch $stagePattern) {
        throw [IO.IOException]::new("Refusing to remove an unowned staging directory.")
    }
    $directories = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
    $allDirectories = [Collections.Generic.List[IO.DirectoryInfo]]::new()
    $allFiles = [Collections.Generic.List[IO.FileInfo]]::new()
    $directories.Push($info)
    while ($directories.Count -gt 0) {
        $current = $directories.Pop()
        $current.Refresh()
        if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("Refusing to remove a staging tree that contains a reparse point.") }
        $allDirectories.Add($current)
        foreach ($child in $current.GetFileSystemInfos()) {
            $child.Refresh()
            if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("Refusing to remove a staging tree that contains a reparse point.") }
            if ($child -is [IO.DirectoryInfo]) { $directories.Push([IO.DirectoryInfo]$child) }
            else { $allFiles.Add([IO.FileInfo]$child) }
        }
    }
    foreach ($file in $allFiles) {
        $file.Refresh()
        if ($file.Exists) {
            if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("Refusing to remove a staging tree that changed into a reparse point.") }
            $file.Delete()
        }
    }
    foreach ($directory in @($allDirectories | Sort-Object { $_.FullName.Length } -Descending)) {
        $directory.Refresh()
        if ($directory.Exists) {
            if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("Refusing to remove a staging tree that changed into a reparse point.") }
            $directory.Delete($false)
        }
    }
}

function Get-ProtectedPendingStage {
    param([string]$PackagePath, [string]$ExpectedParent, [string]$StagePattern)
    $pendingPath = Get-PendingPath
    if (-not [IO.File]::Exists($pendingPath)) { return $null }
    $pending = Read-StrictJsonFile -Path $pendingPath -MaximumBytes 65536
    Assert-ExactObject -Value $pending -Properties @(
        "schemaVersion", "state", "candidateId", "packageRoot", "stageRoot", "stateDirectory", "port",
        "currentVersion", "currentCommit", "latestVersion", "latestCommit", "treeSha256", "fileCount",
        "unpackedBytes", "brokerSha256", "healthNonce", "stagedAt"
    ) -Label "pending update"
    $stage = [IO.Path]::GetFullPath([string]$pending.stageRoot)
    $stageInfo = [IO.DirectoryInfo]::new($stage)
    if (
        $pending.schemaVersion -ne 1 -or $pending.state -cne "READY_TO_RESTART" -or
        $pending.candidateId -isnot [string] -or $pending.candidateId -notmatch '^[A-Za-z0-9_-]{40,64}$' -or
        -not ([string]$pending.packageRoot).Equals($PackagePath, [StringComparison]::OrdinalIgnoreCase) -or
        $null -eq $stageInfo.Parent -or -not $stageInfo.Parent.FullName.Equals($ExpectedParent, [StringComparison]::OrdinalIgnoreCase) -or
        $stageInfo.Name -notmatch $StagePattern
    ) { throw [IO.InvalidDataException]::new("The pending update cannot protect a staging directory.") }
    if ($stageInfo.Exists -and ($stageInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The pending staging directory is a reparse point.") }
    return $stage
}

function Remove-StaleWorkerArtifacts {
    param([string]$PackagePath)
    $package = [IO.Path]::GetFullPath($PackagePath).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $parent = [IO.Path]::GetFullPath((Split-Path -Parent $package)).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $parentInfo = [IO.DirectoryInfo]::new($parent)
    $parentInfo.Refresh()
    if (($parentInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The package parent must not be a reparse point.") }
    $stagePattern = '^\.' + [Regex]::Escape([IO.Path]::GetFileName($package)) + '\.update-stage-[A-Za-z0-9_-]{40,64}$'
    $protectedStage = Get-ProtectedPendingStage -PackagePath $package -ExpectedParent $parent -StagePattern $stagePattern

    $updateInfo = [IO.DirectoryInfo]::new((Get-UpdateDirectory))
    foreach ($file in $updateInfo.GetFiles()) {
        if ($file.Name -notmatch '^package-[A-Za-z0-9_-]{40,64}\.[0-9a-f]{32}\.zip$') { continue }
        $file.Refresh()
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("Refusing to remove a reparse-point update archive.") }
        $file.Delete()
    }
    foreach ($directory in $parentInfo.GetDirectories()) {
        if ($directory.Name -notmatch $stagePattern -or ($null -ne $protectedStage -and $directory.FullName.Equals($protectedStage, [StringComparison]::OrdinalIgnoreCase))) { continue }
        Remove-OwnedStageDirectory -Path $directory.FullName -ExpectedParent $parent
    }
}

function Invoke-Check {
    param([object]$Configuration, [object]$CurrentVersion)
    if ($Configuration.updaterEnabled -cne $true) { throw [InvalidOperationException]::new("Updates are not configured for this package.") }
    $verified = Get-VerifiedReleaseCandidate -Configuration $Configuration -CurrentVersion $CurrentVersion
    if ((Compare-StableVersion $verified.Manifest.version $CurrentVersion.version) -le 0) {
        Write-Status ([ordered]@{
            state = "CURRENT"
            currentVersion = [string]$CurrentVersion.version
            latestVersion = [string]$verified.Manifest.version
            checkedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
        })
        if ([IO.File]::Exists((Get-CandidatePath))) { [IO.File]::Delete((Get-CandidatePath)) }
        return
    }
    $candidate = Get-RandomIdentifier
    $now = [DateTime]::UtcNow
    $configBytes = [IO.File]::ReadAllBytes((Join-Path ([IO.Path]::GetFullPath($PackageRoot)) "UPDATE_CONFIG.json"))
    Write-AtomicJson -Path (Get-CandidatePath) -Value ([ordered]@{
        schemaVersion = 1
        candidateId = $candidate
        currentVersion = [string]$CurrentVersion.version
        currentCommit = [string]$CurrentVersion.commit
        latestVersion = [string]$verified.Manifest.version
        releaseId = [long]$verified.Release.Document.id
        publishedAt = [string]$verified.Release.PublishedAt
        releasePageUrl = [string]$verified.Release.Document.html_url
        downloadBytes = [long]$verified.Manifest.artifacts.direct.bytes
        manifestSha256 = [string]$verified.ManifestSha256
        manifestBase64 = [Convert]::ToBase64String($verified.ManifestBytes)
        signatureBase64 = [Convert]::ToBase64String($verified.SignatureBytes)
        configSha256 = Get-Sha256Hex $configBytes
        port = $Port
        createdAt = $now.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
        expiresAt = $now.AddHours($candidateLifetimeHours).ToString("o", [Globalization.CultureInfo]::InvariantCulture)
    })
    Write-Status ([ordered]@{
        state = "AVAILABLE"
        currentVersion = [string]$CurrentVersion.version
        latestVersion = [string]$verified.Manifest.version
        publishedAt = [string]$verified.Release.PublishedAt
        releasePageUrl = [string]$verified.Release.Document.html_url
        downloadBytes = [long]$verified.Manifest.artifacts.direct.bytes
        candidateId = $candidate
    })
}

function Read-Candidate {
    param([object]$Configuration, [object]$CurrentVersion)
    if ($CandidateId -notmatch '^[A-Za-z0-9_-]{40,64}$') { throw [ArgumentException]::new("The candidate identifier is invalid.") }
    $candidate = Read-StrictJsonFile -Path (Get-CandidatePath) -MaximumBytes 4MB
    Assert-ExactObject -Value $candidate -Properties @("schemaVersion", "candidateId", "currentVersion", "currentCommit", "latestVersion", "releaseId", "publishedAt", "releasePageUrl", "downloadBytes", "manifestSha256", "manifestBase64", "signatureBase64", "configSha256", "port", "createdAt", "expiresAt") -Label "update candidate"
    if ($candidate.schemaVersion -ne 1 -or $candidate.candidateId -cne $CandidateId -or $candidate.currentVersion -cne $CurrentVersion.version -or $candidate.currentCommit -cne $CurrentVersion.commit -or -not (Test-StableVersion $candidate.latestVersion) -or (Compare-StableVersion $candidate.latestVersion $CurrentVersion.version) -le 0 -or -not (Test-SafeInteger $candidate.releaseId 1) -or -not (Test-SafeInteger $candidate.downloadBytes 1 $maximumArchiveBytes) -or $candidate.manifestSha256 -isnot [string] -or $candidate.manifestSha256 -notmatch '^[0-9a-f]{64}$' -or $candidate.configSha256 -isnot [string] -or $candidate.configSha256 -notmatch '^[0-9a-f]{64}$' -or $candidate.port -isnot [int] -or $candidate.port -lt 1 -or $candidate.port -gt 65535) {
        throw [IO.InvalidDataException]::new("The saved update candidate is invalid or stale.")
    }
    if ($candidate.port -ne $Port) { throw [IO.InvalidDataException]::new("The reviewed update candidate belongs to a different local origin.") }
    $configBytes = [IO.File]::ReadAllBytes((Join-Path ([IO.Path]::GetFullPath($PackageRoot)) "UPDATE_CONFIG.json"))
    if ((Get-Sha256Hex $configBytes) -cne $candidate.configSha256) { throw [Security.Cryptography.CryptographicException]::new("The pinned update configuration changed after the update check.") }
    [DateTimeOffset]$expires = [DateTimeOffset]::MinValue
    if ($candidate.expiresAt -isnot [string] -or -not [DateTimeOffset]::TryParse($candidate.expiresAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$expires) -or $expires -le [DateTimeOffset]::UtcNow) { throw [IO.InvalidDataException]::new("The saved update candidate expired.") }
    try {
        $manifestBytes = [Convert]::FromBase64String([string]$candidate.manifestBase64)
        $signatureBytes = [Convert]::FromBase64String([string]$candidate.signatureBase64)
    } catch { throw [IO.InvalidDataException]::new("The saved update candidate is corrupt.") }
    if ($manifestBytes.Length -gt $maximumManifestBytes -or $signatureBytes.Length -gt $maximumSignatureBytes -or (Get-Sha256Hex $manifestBytes) -cne $candidate.manifestSha256) { throw [Security.Cryptography.CryptographicException]::new("The saved update manifest changed.") }
    $release = Read-ReleaseDocument -Configuration $Configuration -ReleaseId ([long]$candidate.releaseId)
    $manifest = Assert-SignedManifest -ManifestBytes $manifestBytes -SignatureBytes $signatureBytes -Configuration $Configuration -ReleaseRecord $release
    if ($manifest.version -cne $candidate.latestVersion -or $release.PublishedAt -cne $candidate.publishedAt -or $release.Document.html_url -cne $candidate.releasePageUrl -or [long]$manifest.artifacts.direct.bytes -ne [long]$candidate.downloadBytes) { throw [IO.InvalidDataException]::new("The immutable release no longer matches the reviewed candidate.") }
    $directAsset = Get-ReleaseAsset -Release $release.Document -Configuration $Configuration -Name $manifest.artifacts.direct.filename -AssetId ([long]$manifest.artifacts.direct.assetId) -MaximumBytes $maximumArchiveBytes
    if ([long]$directAsset.size -ne [long]$manifest.artifacts.direct.bytes -or $directAsset.digest -cne ("sha256:" + $manifest.artifacts.direct.sha256)) { throw [Security.Cryptography.CryptographicException]::new("The direct update asset digest changed.") }
    return [pscustomobject]@{ Record = $candidate; Release = $release; Manifest = $manifest; DirectAsset = $directAsset }
}

function Invoke-Stage {
    param([object]$Configuration, [object]$CurrentVersion)
    if ($Configuration.updaterEnabled -cne $true) { throw [InvalidOperationException]::new("Updates are not configured for this package.") }
    $verified = Read-Candidate -Configuration $Configuration -CurrentVersion $CurrentVersion
    $packagePath = [IO.Path]::GetFullPath($PackageRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if (-not ($AllowTestHttpLoopback -or $env:TARKOV_HELPER_UPDATE_TEST_ALLOW_HTTP -ceq "1") -and -not $packagePath.Equals([IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) {
        throw [IO.IOException]::new("The updater can only replace the Direct package that contains it.")
    }
    if (([IO.File]::GetAttributes($packagePath) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The package root must not be a reparse point.") }
    $parent = Split-Path -Parent $packagePath
    if (([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The package parent must not be a reparse point.") }
    $stageRoot = Join-Path $parent ("." + [IO.Path]::GetFileName($packagePath) + ".update-stage-" + (Get-RandomIdentifier))
    $downloadPath = Join-Path (Get-UpdateDirectory) ("package-" + $CandidateId + "." + [Guid]::NewGuid().ToString("N") + ".zip")
    $stageCreated = $false
    try {
        [IO.Directory]::CreateDirectory($stageRoot) | Out-Null
        $stageCreated = $true
        if (([IO.File]::GetAttributes($stageRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw [IO.IOException]::new("The staging directory became a reparse point.") }
        $startedAt = $StartedAt
        if ([string]::IsNullOrWhiteSpace($startedAt)) {
            $startedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
        }
        $progressState = [pscustomobject]@{ Last = [long]-1 }
        $progress = {
            param([long]$Downloaded)
            if ($Downloaded -eq [long]$verified.Manifest.artifacts.direct.bytes -or $progressState.Last -lt 0 -or ($Downloaded - $progressState.Last) -ge 1MB) {
                $progressState.Last = $Downloaded
                Write-Status ([ordered]@{
                    state = "DOWNLOADING"; currentVersion = [string]$CurrentVersion.version; latestVersion = [string]$verified.Manifest.version
                    candidateId = $CandidateId; downloadedBytes = $Downloaded; downloadBytes = [long]$verified.Manifest.artifacts.direct.bytes; startedAt = $startedAt
                })
            }
            if ($Downloaded -gt 0) { Invoke-TestStageCrash -Phase "DOWNLOAD" }
        }
        $null = Invoke-BoundedDownload -Uri ([Uri]$verified.DirectAsset.url) -ReleaseApi ([Uri]$Configuration.releaseApi) -MaximumBytes $maximumArchiveBytes `
            -ExpectedBytes ([long]$verified.Manifest.artifacts.direct.bytes) -ExpectedDigest ([string]$verified.DirectAsset.digest) -Destination $downloadPath -Progress $progress
        Write-Status ([ordered]@{
            state = "VERIFYING"; currentVersion = [string]$CurrentVersion.version; latestVersion = [string]$verified.Manifest.version
            candidateId = $CandidateId; startedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
        })
        $direct = $verified.Manifest.artifacts.direct
        $null = [TarkovHelperUpdateSupport.SafeZip]::Extract($downloadPath, $stageRoot, [string]$direct.rootDirectory, [int]$direct.unpacked.fileCount, [long]$direct.unpacked.bytes, [string]$direct.unpacked.treeSha256)
        Invoke-TestStageCrash -Phase "EXTRACTED"
        Assert-StagedPackage -StageRoot $stageRoot -Manifest $verified.Manifest -CurrentConfiguration $Configuration
        $brokerHash = Get-FileSha256Hex (Join-Path $packagePath "app-update-broker.ps1")
        $healthNonce = Get-RandomIdentifier
        $transactionLock = $null
        try {
            $transactionLock = Enter-AppUpdateTransactionLock
            $updateDirectory = Get-UpdateDirectory
            foreach ($transactionName in @("pending.json", "apply-journal.json")) {
                if (Test-Path -LiteralPath (Join-Path $updateDirectory $transactionName)) { throw [InvalidOperationException]::new("A prior app update transaction still requires cleanup.") }
            }
            Write-AtomicJson -Path (Get-PendingPath) -Value ([ordered]@{
            schemaVersion = 1
            state = "READY_TO_RESTART"
            candidateId = $CandidateId
            packageRoot = $packagePath
            stageRoot = $stageRoot
            stateDirectory = [IO.Path]::GetFullPath($StateDirectory)
            port = $Port
            currentVersion = [string]$CurrentVersion.version
            currentCommit = [string]$CurrentVersion.commit
            latestVersion = [string]$verified.Manifest.version
            latestCommit = [string]$verified.Manifest.commit
            treeSha256 = [string]$direct.unpacked.treeSha256
            fileCount = [int]$direct.unpacked.fileCount
            unpackedBytes = [long]$direct.unpacked.bytes
            brokerSha256 = $brokerHash
                healthNonce = $healthNonce
                stagedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
            })
            # Ownership transfers durably with pending.json. Keep this state
            # transition inside the same cross-session publication guard so a
            # stale-state archiver can never remove the trigger first.
            $stageCreated = $false
            Write-Status ([ordered]@{
                state = "READY_TO_RESTART"; currentVersion = [string]$CurrentVersion.version; latestVersion = [string]$verified.Manifest.version
                candidateId = $CandidateId; stagedAt = [DateTime]::UtcNow.ToString("o", [Globalization.CultureInfo]::InvariantCulture)
            })
        } finally { Exit-AppUpdateTransactionLock -Lock $transactionLock }
    } finally {
        if ([IO.File]::Exists($downloadPath)) { [IO.File]::Delete($downloadPath) }
        if ($stageCreated) { Remove-OwnedStageDirectory -Path $stageRoot -ExpectedParent $parent }
    }
}

$currentVersion = "0.0.0"
$operation = if ($Action -eq "Check") { "CHECK" } else { "STAGE" }
$lock = $null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $packagePath = [IO.Path]::GetFullPath($PackageRoot)
    $statePath = [IO.Path]::GetFullPath($StateDirectory)
    Write-WorkerLog "$operation worker started for package '$packagePath'."
    if ($statePath.Equals($packagePath, [StringComparison]::OrdinalIgnoreCase) -or $statePath.StartsWith($packagePath.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw [IO.IOException]::new("The runtime state must be outside the replaceable package root.")
    }
    $lockPath = Join-Path (Get-UpdateDirectory) "worker.lock"
    try { $lock = [IO.FileStream]::new($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] { Write-WorkerLog "$operation exited with code 3 because another worker owns the update lock."; exit 3 }
    $updateDirectory = Get-UpdateDirectory
    foreach ($transactionName in @("pending.json", "apply-journal.json")) {
        $transactionPath = Join-Path $updateDirectory $transactionName
        try { $transactionExists = Test-Path -LiteralPath $transactionPath -ErrorAction Stop }
        catch {
            Write-WorkerLog "$operation exited with code 3 because the prior apply transaction state could not be inspected."
            exit 3
        }
        if ($transactionExists) {
            Write-WorkerLog "$operation exited with code 3 while a prior apply transaction still requires cleanup."
            exit 3
        }
    }
    Remove-StaleWorkerArtifacts -PackagePath $packagePath
    $version = Get-CurrentVersionDocument
    $currentVersion = [string]$version.version
    $configuration = Get-UpdateConfiguration
    if ($Action -eq "Check") { Invoke-Check -Configuration $configuration -CurrentVersion $version }
    else { Invoke-Stage -Configuration $configuration -CurrentVersion $version }
    Write-WorkerLog "$operation completed with exit code 0."
    exit 0
} catch [Security.Cryptography.CryptographicException] {
    Write-WorkerLog "$operation cryptographic rejection: $($_.Exception.GetType().Name): $($_.Exception.Message)"
    $code = if ($_.Exception.Message -match '(?i)digest|hash|checksum') { "HASH_MISMATCH" } else { "SIGNATURE_INVALID" }
    Write-ErrorStatus -Operation $operation -CurrentVersion $currentVersion -Code $code -Message "The downloaded update could not be authenticated."
    Write-WorkerLog "$operation completed with exit code 4."
    exit 4
} catch [Net.WebException] {
    $message = [string]$_.Exception.Message
    Write-WorkerLog "$operation network rejection: $($_.Exception.GetType().Name): $message"
    $httpMatch = [regex]::Match($message, 'HTTP (?<status>\d{3})')
    $httpStatus = if ($httpMatch.Success) { [int]$httpMatch.Groups["status"].Value } else { 0 }
    $remainingMatch = [regex]::Match($message, 'X-RateLimit-Remaining=(?<remaining>\d+)')
    $remaining = if ($remainingMatch.Success) { [int64]$remainingMatch.Groups["remaining"].Value } else { -1 }
    if ($httpStatus -eq 429 -or ($httpStatus -eq 403 -and $remaining -eq 0)) {
        Write-ErrorStatus -Operation $operation -CurrentVersion $currentVersion -Code "GITHUB_RATE_LIMIT" -Message "GitHub 공개 API 요청 제한에 도달했습니다. 잠시 후 다시 확인하세요. GitHub 계정이 차단된 것은 아닙니다."
    } elseif ($httpStatus -eq 403) {
        Write-ErrorStatus -Operation $operation -CurrentVersion $currentVersion -Code "GITHUB_FORBIDDEN" -Message "GitHub가 업데이트 요청을 거부했습니다(HTTP 403). VPN, 프록시 또는 방화벽 설정을 확인하세요."
    } else {
        Write-ErrorStatus -Operation $operation -CurrentVersion $currentVersion -Code "NETWORK_ERROR" -Message "The public GitHub release could not be reached."
    }
    Write-WorkerLog "$operation completed with exit code 5."
    exit 5
} catch [InvalidOperationException] {
    Write-WorkerLog "$operation configuration rejection: $($_.Exception.GetType().Name): $($_.Exception.Message)"
    Write-ErrorStatus -Operation $operation -CurrentVersion $currentVersion -Code "NOT_CONFIGURED" -Message "Public updates are not configured for this package."
    Write-WorkerLog "$operation completed with exit code 6."
    exit 6
} catch [ArgumentException] {
    Write-WorkerLog "$operation candidate rejection: $($_.Exception.GetType().Name): $($_.Exception.Message)"
    Write-ErrorStatus -Operation $operation -CurrentVersion $currentVersion -Code "CANDIDATE_MISMATCH" -Message "The reviewed update candidate is no longer valid."
    Write-WorkerLog "$operation completed with exit code 7."
    exit 7
} catch {
    Write-WorkerLog "$operation trust-policy rejection: $($_.Exception.GetType().Name): $($_.Exception.Message)"
    $code = if ($Action -eq "Check") { "INVALID_RELEASE" } else { "INVALID_PACKAGE" }
    $message = if ($Action -eq "Check") { "The public release did not satisfy the update trust policy." } else { "The downloaded package did not satisfy the update trust policy." }
    try { Write-ErrorStatus -Operation $operation -CurrentVersion $currentVersion -Code $code -Message $message } catch { }
    Write-WorkerLog "$operation completed with exit code 8."
    exit 8
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
}
