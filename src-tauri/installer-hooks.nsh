; NSIS installer hooks for Straylight (Tauri v2 `bundle.windows.nsis.installerHooks`).
;
; Registers the "Open with Straylight" right-click verb so Explorer can launch
; the app on a file or folder. Everything is written under HKCU\Software\Classes
; (per-user, matching `installMode: currentUser`) so no elevation is needed, and
; is removed on uninstall.
;
;   %1  the clicked file or folder path (files, folders)
;   %V  the folder being viewed (folder background — right-click empty space)
;
; ${MAINBINARYNAME} is the installed exe name (without .exe); $INSTDIR is the
; install directory. Both are provided by the Tauri NSIS template.

!macro NSIS_HOOK_POSTINSTALL
  ; Files (any type).
  WriteRegStr HKCU "Software\Classes\*\shell\Straylight" "" "Open with Straylight"
  WriteRegStr HKCU "Software\Classes\*\shell\Straylight" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\Straylight\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; Folders (right-click a folder).
  WriteRegStr HKCU "Software\Classes\Directory\shell\Straylight" "" "Open with Straylight"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Straylight" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\Straylight\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; Folder background (right-click empty space inside a folder).
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Straylight" "" "Open with Straylight"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Straylight" "Icon" "$INSTDIR\${MAINBINARYNAME}.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\Straylight\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%V"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\*\shell\Straylight"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\Straylight"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\Straylight"
!macroend
