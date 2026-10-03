import { Router } from "express";
import { requireToken } from "../auth/authorization.js";
import type { Dependencias } from "../dependencias.js";
import type { Marca, Perfil, Vinculo } from "../dominio/tipos.js";
import { AppError } from "../http/errors.js";
import { normalizarCorreo } from "../usuarios/correo.js";

/** Contrato I-02 v1. */
export interface RegistroResponse {
  vinculo: Vinculo;
  marcas: Marca[];
}

/**
 * Registro de cliente tras crear la cuenta en Firebase Auth (SRC-02 p. 2,
 * SRC-03 pp. 3–4). El correo sale del token verificado, nunca del cuerpo:
 * el vínculo sólo se evalúa con un correo cuya propiedad está verificada.
 */
export function registroRouter(deps: Dependencias): Router {
  const router = Router();
  router.post(
    "/clientes/registro",
    requireToken(deps.tokenVerifier),
    async (req, res) => {
      const token = req.token!;
      if (!token.correo) {
        throw new AppError(
          422,
          "VALIDATION_ERROR",
          "La cuenta no tiene un correo asociado.",
        );
      }
      if (!token.correoVerificado) {
        throw new AppError(
          403,
          "EMAIL_NOT_VERIFIED",
          "Verifica tu correo antes de completar el registro.",
        );
      }

      const correo = normalizarCorreo(token.correo);
      const legacy = await deps.fuenteLegacy.buscarPorCorreo(correo);
      const ahora = deps.reloj().toISOString();
      const perfil: Perfil = {
        uid: token.uid,
        correo,
        rol: "cliente",
        activo: true,
        marcas: legacy?.marcas ?? [],
        vinculo: legacy ? "vinculado" : "no_vinculado",
        creadoEn: ahora,
      };

      const resultado = await deps.perfiles.registrar(perfil, {
        accion: "cliente.registrado",
        actor: token.uid,
        objetivoUid: token.uid,
        en: ahora,
        datos: { vinculo: perfil.vinculo, marcas: perfil.marcas },
      });
      if (resultado === "uid_existente") {
        throw new AppError(
          409,
          "ALREADY_REGISTERED",
          "La cuenta ya está registrada.",
        );
      }
      if (resultado === "correo_existente") {
        throw new AppError(
          409,
          "EMAIL_ALREADY_LINKED",
          "Este correo ya está vinculado a otra cuenta.",
        );
      }

      const body: RegistroResponse = {
        vinculo: perfil.vinculo,
        marcas: perfil.marcas,
      };
      res.status(201).json(body);
    },
  );
  return router;
}
