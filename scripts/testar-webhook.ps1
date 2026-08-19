$ErrorActionPreference = 'Stop'

$testId = 'teste-webhook-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$body = @{
    nome = 'Pessoa do webhook'
    telefone = '5511988887777'
    mensagem = 'Ola, esta mensagem chegou pelo webhook.'
    id_mensagem = $testId
} | ConvertTo-Json

$response = Invoke-RestMethod `
    -Method Post `
    -Uri 'http://localhost:5678/webhook/whatsapp-mensagens' `
    -ContentType 'application/json' `
    -Body $body

$response | ConvertTo-Json
