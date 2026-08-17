import { execFileSync } from 'node:child_process';

const dir = 'D:/CodeProjects/ReSplat/数据/LCC/导出/土楼2/data/3dgs';
const ps = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dir = '${dir}'
Get-ChildItem -Path $dir -Filter *.sog | Sort-Object Name | ForEach-Object {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($_.FullName)
  $entry = $zip.Entries | Where-Object { $_.FullName -eq 'meta.json' }
  if ($entry) {
    $reader = New-Object System.IO.StreamReader($entry.Open())
    $json = $reader.ReadToEnd()
    $reader.Close()
    $obj = $json | ConvertFrom-Json
    $shKeys = ($obj.psobject.Properties.Name | Where-Object { $_ -like 'sh*' }) -join ','
    $layers = ($obj.psobject.Properties.Name | Where-Object { $_ -in @('means','scales','quats','rot','position','geometric','color') }) -join ','
    Write-Output ($_.Name + " | count=" + $obj.count + " | shKeys=[" + $shKeys + "] | layers=[" + $layers + "]")
  }
  $zip.Dispose()
}
`;
const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
console.log(out);
