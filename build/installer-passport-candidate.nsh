!include "installer.nsh"

# Passport candidate packages are installable only. The installer owns the
# callback registration so it is bound to the stable installed executable and
# the uninstaller can remove it deterministically.
!macro customInstall
  WriteRegStr HKCU "Software\Classes\wangsan-wordtaker" "" "URL:Wangsan WordTaker OAuth"
  WriteRegStr HKCU "Software\Classes\wangsan-wordtaker" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\wangsan-wordtaker\DefaultIcon" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\",0"
  WriteRegStr HKCU "Software\Classes\wangsan-wordtaker\shell\open\command" "" "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\""
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Software\Classes\wangsan-wordtaker\shell\open\command" ""
  StrCmp $0 "$\"$INSTDIR\${APP_EXECUTABLE_FILENAME}$\" $\"%1$\"" 0 PassportProtocolCleanupDone
  DeleteRegKey HKCU "Software\Classes\wangsan-wordtaker"
  PassportProtocolCleanupDone:
!macroend
