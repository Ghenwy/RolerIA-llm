# Contribuir

Esta distribución contiene fuentes y documentación pública, no el workspace privado de investigación.

1. Instala dependencias fijadas: `npm ci` desde DDRolLocal.
2. Ejecuta `npm run check:source` y lint para los cambios de código.
3. Para cambios de comportamiento, reproduce el fallo, añade una prueba sintética mínima, identifica causa, aplica fix y comprueba regresión. No publiques reproducciones privadas.
4. Mantén contratos compartidos TS/Python y regeneración desde schemas; no alteres la autoridad mecánica del código.
5. Revisa el diff y todos los archivos preparados antes de enviar una contribución.

Nunca incluir configuraciones reales, pruebas internas, datos personales, modelos, binarios, campañas, logs crudos ni investigación del mantenedor. Usa valores ficticios en ejemplos. `config/` pertenece exclusivamente a la instalación local.

No fuerces resultados de compactación ni cambies el SOT interno para hacer pasar pruebas. Referencias históricas relativas en contratos son procedencia, no autorización para solicitar o publicar documentación privada.

[Seguridad](SECURITY.md) · [Instalación](INSTALL.md)
