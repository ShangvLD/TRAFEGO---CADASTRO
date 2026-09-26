' Roda um .cmd SEM MOSTRAR JANELA nenhuma.
'
' Motivo (28/08/2026): a tarefa "TRAFEGO - Espelhar canal" roda a cada 10 MINUTOS e chamava
' `cmd.exe /c espelhar-canal.cmd` direto. O Agendador abre a janela preta do console na frente
' do usuario a cada passada - 6 vezes por hora, atrapalhando apresentacoes.
'
' Este lancador inicia o .cmd com estilo de janela 0 (oculta) e ESPERA terminar, devolvendo o
' codigo de saida pro Agendador (o historico continua mostrando sucesso/erro corretamente).
'
' Uso na tarefa agendada:
'     wscript.exe "<esta pasta>\rodar_oculto.vbs" espelhar-canal.cmd
'
' Pra rodar na mao vendo a janela, chame o .cmd direto (duplo clique).
'
' E' irmao do `_automacao\rodar_oculto.vbs`, mas DE PROPOSITO sem a limpeza de trava orfa:
' aquela trava e' dos robos de portal (eLog/checklist/manutencao) e nao tem nada a ver com
' este projeto. Copiar a logica pra ca so criaria a chance de este script mexer numa trava
' que nao e' dele.
Option Explicit

Dim sh, fso, pasta, alvo, linha

If WScript.Arguments.Count < 1 Then
    WScript.Quit 2   ' faltou dizer qual .cmd rodar
End If

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

' resolve o .cmd relativo a ESTA pasta (o Agendador pode chamar de qualquer diretorio)
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
alvo  = fso.BuildPath(pasta, WScript.Arguments(0))

If Not fso.FileExists(alvo) Then
    WScript.Quit 3   ' .cmd nao encontrado
End If

sh.CurrentDirectory = pasta
linha = "cmd.exe /c """ & alvo & """"

' 0    = janela oculta
' True = espera terminar (o Run devolve o codigo de saida do .cmd)
WScript.Quit sh.Run(linha, 0, True)
