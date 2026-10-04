import { Router } from "express";
import { requireAuth } from "../auth/authorization.js";
import type { Dependencias } from "../dependencias.js";
import type { Marca, Rol, Vinculo } from "../dominio/tipos.js";

/** Contrato I-01 v1. */
export interface MeResponse {
  uid: string;
  rol: Rol;
  activo: boolean;
  marcas: Marca[];
  vinculo: Vinculo;
}

export function meRouter(deps: Dependencias): Router {
  const router = Router();
  router.get(
    "/me",
    requireAuth(deps.tokenVerifier, deps.perfiles),
    (req, res) => {
      const perfil = req.perfil;
      const body: MeResponse = {
        uid: req.auth!.uid,
        rol: req.auth!.rol,
        activo: req.auth!.activo,
        marcas: req.auth!.marcas,
        vinculo: perfil?.vinculo ?? "no_vinculado",
      };
      res.set("Cache-Control", "no-store").json(body);
    },
  );
  return router;
}
