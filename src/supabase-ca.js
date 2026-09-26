/* ============================================================================
   Certificado da autoridade que assina os servidores do Supabase

   POR QUE ESTÁ EM UM .js, e não em um .crt: o Vercel monta o bundle da função
   a partir dos require(). Arquivo lido com fs em tempo de execução pode não
   ser incluído — e a falta dele derrubaria a conexão com o banco inteira. Como
   módulo, entra no bundle junto do código.

   ORIGEM: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
   (é o mesmo arquivo que o painel oferece em Connect > "Download certificate")

     Titular   : C=US, ST=Delware, L=New Castle, O=Supabase Inc,
                 CN=Supabase Root 2021 CA
     Validade  : 2021-04-28  ->  2031-04-26
     SHA-256   : 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:
                 82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA

   Sem ele a conexão era feita com rejectUnauthorized:false — ou seja, TLS
   ligado mas SEM conferir com quem se está falando, o que não protege de um
   intermediário. Com o CA, o Node valida a cadeia e o nome do host.

   QUANDO TROCAR: quando o Supabase publicar um CA novo (este vence em 2031) ou
   se a conexão passar a falhar com UNABLE_TO_VERIFY_LEAF_SIGNATURE / 
   SELF_SIGNED_CERT_IN_CHAIN. Baixe o arquivo do painel e substitua o texto
   abaixo. Em emergência, DATABASE_SSL_STRICT=0 volta ao comportamento antigo.
   ========================================================================== */

module.exports = `
-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----
`;
