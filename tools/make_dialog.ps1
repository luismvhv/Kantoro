# Kantoro — genera un diálogo de prueba con varias voces de Windows para medir la distinción de personajes.
# Uso: powershell -ExecutionPolicy Bypass -File tools\make_dialog.ps1
# Salida: test/dialog4.wav (16 kHz, mono, 16 bits) y test/dialog4_segs.json (quién habla y cuándo).
# El idioma da igual (la distinción solo usa tono y timbre). Voces: las de Windows (escritorio y OneCore) que haya.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media.SpeechSynthesis, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }

$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$all = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
Write-Host ('Voces: ' + (($all | ForEach-Object { $_.DisplayName + '/' + $_.Gender }) -join ', '))
function Voice($name) { $all | Where-Object { $_.DisplayName -like "*$name*" } | Select-Object -First 1 }

# Personajes: voz + tono (SSML). D es la misma voz que B con el tono subido: dos voces "parecidas pero distintas".
$cast = @{
  A = @{ v = (Voice 'Pablo');  pitch = '+0%' }
  B = @{ v = (Voice 'Helena'); pitch = '+0%' }
  C = @{ v = (Voice 'Laura');  pitch = '+0%' }
  D = @{ v = (Voice 'Helena'); pitch = '+35%' }
}
$lines = @(
  @('A', 'Oye, espera un momento, por favor.'),
  @('B', '¿Qué pasa? ¿Por qué tienes tanta prisa?'),
  @('A', 'Ha ocurrido algo muy grave en el pueblo.'),
  @('C', '¿Qué ha pasado? Cuéntamelo todo.'),
  @('B', 'Tranquilo, respira y habla despacio.'),
  @('D', '¡Yo también quiero saberlo!'),
  @('A', 'El templo de la colina se ha incendiado esta noche.'),
  @('C', 'No puede ser, mi abuela vive allí.'),
  @('A', 'No hay tiempo, tenemos que irnos ya.'),
  @('D', 'Hermano, espérame.'),
  @('B', 'Cogeos de la mano y corred.'),
  @('C', 'Vamos, todos juntos.'),
  @('A', 'Bien, ya estamos todos.'),
  @('D', 'Tengo miedo, pero iré contigo.'),
  @('B', 'No te preocupes, yo te protejo.')
)
$rate = 16000
$pcm = New-Object System.Collections.Generic.List[byte]
$segs = @()
$rnd = New-Object System.Random 7
function AddSilence($sec) { $n = [int]($sec * $rate) * 2; for ($i = 0; $i -lt $n; $i++) { $pcm.Add(0) } }
AddSilence 0.5
foreach ($ln in $lines) {
  $c = $cast[$ln[0]]
  if (-not $c.v) { throw "Falta la voz del personaje $($ln[0])" }
  $synth.Voice = $c.v
  $lang = $c.v.Language
  $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='$lang'><prosody pitch='$($c.pitch)'>$([Security.SecurityElement]::Escape($ln[1]))</prosody></speak>"
  $stream = Await ($synth.SynthesizeSsmlToStreamAsync($ssml)) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
  $size = [uint32]$stream.Size
  $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
  $null = Await ($reader.LoadAsync($size)) ([uint32])
  $bytes = New-Object byte[] $size; $reader.ReadBytes($bytes)
  # WAV de la síntesis: buscar el bloque 'data' y leer formato
  $ch = [BitConverter]::ToInt16($bytes, 22); $sr = [BitConverter]::ToInt32($bytes, 24)
  $p = 12; while ($p -lt $bytes.Length - 8) { $id = [Text.Encoding]::ASCII.GetString($bytes, $p, 4); $len = [BitConverter]::ToInt32($bytes, $p + 4); if ($id -eq 'data') { break }; $p += 8 + $len }
  $p += 8
  $nIn = [int](($bytes.Length - $p) / (2 * $ch))
  $start = $pcm.Count / 2 / $rate
  # remuestreo lineal a 16 kHz (canal 0)
  $nOut = [int]($nIn * $rate / $sr)
  for ($i = 0; $i -lt $nOut; $i++) {
    $x = $i * $sr / $rate; $k = [int][Math]::Floor($x); $fr = $x - $k
    if ($k + 1 -ge $nIn) { $k = $nIn - 2; $fr = 1 }
    $a = [BitConverter]::ToInt16($bytes, $p + $k * 2 * $ch); $b = [BitConverter]::ToInt16($bytes, $p + ($k + 1) * 2 * $ch)
    $v = [int16][Math]::Round($a + ($b - $a) * $fr)
    $vb = [BitConverter]::GetBytes($v); $pcm.Add($vb[0]); $pcm.Add($vb[1])
  }
  $end = $pcm.Count / 2 / $rate
  $segs += [pscustomobject]@{ spk = $ln[0]; text = $ln[1]; start = [Math]::Round($start, 3); end = [Math]::Round($end, 3) }
  AddSilence (0.35 + $rnd.NextDouble() * 0.5)
}
# Música de fondo suave (acordes sostenidos) mezclada en todo el diálogo, como en un anime
Add-Type -TypeDefinition @'
public static class KMix {
  public static byte[] Mix(byte[] pcm, int rate, double amp) {
    int n = pcm.Length / 2; var o = new byte[n * 2];
    double[] notes = { 220, 277.18, 329.63, 196, 246.94, 293.66 };
    for (int i = 0; i < n; i++) {
      double t = (double)i / rate; int c = ((int)(t / 4)) % 2; double m = 0;
      for (int j = 0; j < 3; j++) { double f = notes[c * 3 + j]; m += System.Math.Sin(2 * System.Math.PI * f * t) + 0.3 * System.Math.Sin(4 * System.Math.PI * f * t); }
      int s = (short)(pcm[i * 2] | (pcm[i * 2 + 1] << 8));
      int v = (int)(s + m * amp); if (v > 32767) v = 32767; if (v < -32768) v = -32768;
      o[i * 2] = (byte)(v & 255); o[i * 2 + 1] = (byte)((v >> 8) & 255);
    }
    return o;
  }
}
'@
$n = $pcm.Count / 2
$out = [KMix]::Mix($pcm.ToArray(), $rate, 600)
$wav = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($wav)
$w.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $w.Write([int](36 + $out.Length)); $w.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
$w.Write([int]16); $w.Write([int16]1); $w.Write([int16]1); $w.Write([int]$rate); $w.Write([int]($rate * 2)); $w.Write([int16]2); $w.Write([int16]16)
$w.Write([Text.Encoding]::ASCII.GetBytes('data')); $w.Write([int]$out.Length); $w.Write($out)
[IO.File]::WriteAllBytes((Join-Path $root 'test\dialog4.wav'), $wav.ToArray())
[IO.File]::WriteAllText((Join-Path $root 'test\dialog4_segs.json'), ($segs | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
Write-Host ("Listo: {0} frases, {1:N1} s" -f $segs.Count, ($n / $rate))
