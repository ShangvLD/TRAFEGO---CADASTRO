@echo off
rem ===========================================================================
rem  Espelha os documentos do portal na pasta do canal do Teams.
rem
rem  Chamado pela tarefa agendada "TRAFEGO - Espelhar canal", a cada 10 min.
rem  Para rodar na mao, e so dar um duplo clique neste arquivo.
rem
rem  POR QUE UM .CMD E NAO O NODE DIRETO NA TAREFA: a tarefa precisa entrar na
rem  pasta do projeto antes (o .env e o node_modules estao la), e precisa de um
rem  lugar para escrever o log. Colocar isso na linha de comando da tarefa
rem  deixaria a configuracao invisivel; aqui da para ler e mudar.
rem ===========================================================================

cd /d "%~dp0.."

rem O log fica na propria pasta do projeto, em "logs\", e e sobrescrito a cada
rem passada: interessa o que aconteceu AGORA. Acumular viraria arquivo gigante
rem que ninguem le.
if not exist "logs" mkdir "logs"

echo ============================================================ >> "logs\espelho.log"
echo Inicio: %date% %time% >> "logs\espelho.log"

node src\sincronizar-canal.js >> "logs\espelho.log" 2>&1

echo Fim: %date% %time% (codigo %errorlevel%) >> "logs\espelho.log"

rem Log muito grande vira um arquivo novo: 2 MB e o suficiente para varios dias
rem de historico, e evita que o arquivo cresca sem limite.
for %%A in ("logs\espelho.log") do if %%~zA GTR 2097152 move /y "logs\espelho.log" "logs\espelho.anterior.log" >nul

exit /b %errorlevel%
