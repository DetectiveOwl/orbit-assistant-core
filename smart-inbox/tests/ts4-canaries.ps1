param([string]$Stage)
$ErrorActionPreference='Stop'
$native=& (Join-Path $PSScriptRoot 'ts3-handles.ps1') -Stage $Stage | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
if(-not[Windows.Forms.Form].IsSubclassOf([Windows.Forms.Control])){throw 'WINDOWS_CONFIRMATION_ASSEMBLY_UNAVAILABLE'}
$native|Add-Member -NotePropertyName confirmationAssemblyAvailable -NotePropertyValue $true
$native|ConvertTo-Json -Depth 6
