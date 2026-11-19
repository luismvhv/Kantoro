# Copia a web/ lo que la web app comparte con la extensión (motor y diccionarios), para que web/ sea una
# carpeta autónoma lista para publicar. La fuente única es ext/: tras tocar ext/engine o ext/data, vuelve a ejecutarlo.
# Uso:  powershell -ExecutionPolicy Bypass -File tools\build_web.ps1
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ext = Join-Path $root 'ext'; $web = Join-Path $root 'web'
foreach ($d in 'engine', 'lib', 'kuromoji-dict', 'data\jmdict') { New-Item -ItemType Directory -Force (Join-Path $web $d) | Out-Null }
foreach ($f in 'romaji.js', 'dict.js', 'analyzer.js') { Copy-Item (Join-Path $ext "engine\$f") (Join-Path $web "engine\$f") -Force }
Copy-Item (Join-Path $ext 'lib\*') (Join-Path $web 'lib') -Force
Copy-Item (Join-Path $ext 'kuromoji-dict\*') (Join-Path $web 'kuromoji-dict') -Force
Copy-Item (Join-Path $ext 'data\kanji.json.gz') (Join-Path $web 'data\kanji.json.gz') -Force
Copy-Item (Join-Path $ext 'data\jmdict\*') (Join-Path $web 'data\jmdict') -Force
$n = (Get-ChildItem $web -Recurse -File | Measure-Object Length -Sum)
"web/ lista: {0} archivos, {1:N1} MB" -f $n.Count, ($n.Sum / 1MB)
