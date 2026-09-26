# Generates the PWA icons in ../icons (teal tile with a face inside scan brackets).
# Run: powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force $out | Out-Null

function New-Icon([int]$size, [string]$name, [double]$pad, [bool]$rounded) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $teal = [System.Drawing.Color]::FromArgb(15, 123, 108)
  $bg = New-Object System.Drawing.SolidBrush $teal
  if ($rounded) {
    $r = $size * 0.22; $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r, $r, 180, 90); $path.AddArc($size - $r, 0, $r, $r, 270, 90)
    $path.AddArc($size - $r, $size - $r, $r, $r, 0, 90); $path.AddArc(0, $size - $r, $r, $r, 90, 90)
    $path.CloseFigure(); $g.FillPath($bg, $path)
  } else { $g.FillRectangle($bg, 0, 0, $size, $size) }

  $w = [float]($size * 0.055)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), $w
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'; $pen.LineJoin = 'Round'
  $a = $size * $pad; $b = $size - $a; $L = ($b - $a) * 0.24
  # scan brackets
  $g.DrawLines($pen, [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF $a, ($a + $L)), (New-Object System.Drawing.PointF $a, $a), (New-Object System.Drawing.PointF ($a + $L), $a)))
  $g.DrawLines($pen, [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF ($b - $L), $a), (New-Object System.Drawing.PointF $b, $a), (New-Object System.Drawing.PointF $b, ($a + $L))))
  $g.DrawLines($pen, [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF $a, ($b - $L)), (New-Object System.Drawing.PointF $a, $b), (New-Object System.Drawing.PointF ($a + $L), $b)))
  $g.DrawLines($pen, [System.Drawing.PointF[]]@((New-Object System.Drawing.PointF ($b - $L), $b), (New-Object System.Drawing.PointF $b, $b), (New-Object System.Drawing.PointF $b, ($b - $L))))
  # face: eyes + smile
  $c = $size / 2; $s = $b - $a
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $e = $s * 0.075
  $g.FillEllipse($white, [float]($c - $s * 0.17 - $e / 2), [float]($c - $s * 0.1 - $e / 2), [float]$e, [float]$e)
  $g.FillEllipse($white, [float]($c + $s * 0.17 - $e / 2), [float]($c - $s * 0.1 - $e / 2), [float]$e, [float]$e)
  $g.DrawArc($pen, [float]($c - $s * 0.2), [float]($c - $s * 0.1), [float]($s * 0.4), [float]($s * 0.3), 20, 140)
  $bmp.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
New-Icon 192 'icon-192.png' 0.24 $true
New-Icon 512 'icon-512.png' 0.24 $true
New-Icon 512 'icon-maskable-512.png' 0.3 $false
New-Icon 180 'apple-touch-icon.png' 0.24 $false
Get-ChildItem $out | Select-Object Name, Length
