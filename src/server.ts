import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import zlib from "zlib";
import archiver from "archiver";
import { Readable } from "stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();

app.use((req, res, next) => {
  res.setHeader("Connection", "close");
  next();
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "../public")));

const s3Client = new S3Client({ region: "sa-east-1" });
const BUCKET_NAME = "aspira-cloud";

const verificarTokenESP = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers["x-api-key"];
  if (token !== "secret-token-2026") {
    return res.status(401).json({ erro: "Acesso não autorizado" });
  }
  next();
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++)
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ============================================================================
// ROTAS DO MICROCONTROLADOR (ESP32)
// ============================================================================

app.put(
  "/api/upload-esp/:dlg_id/:pasta_data/:filename",
  express.raw({ type: "application/octet-stream", limit: "10mb" }),
  verificarTokenESP,
  async (req: Request, res: Response): Promise<any> => {
    req.setTimeout(300000);

    try {
      const { dlg_id, pasta_data, filename } = req.params;
      const arquivoBuffer = req.body;

      if (!arquivoBuffer || arquivoBuffer.length === 0) {
        return res.status(400).json({ erro: "Corpo da requisição vazio" });
      }

      const expectedSizeHeader =
        req.header("X-File-Size") || req.header("Content-Length") || "-1";
      const expectedSize = parseInt(expectedSizeHeader, 10);
      const expectedCrcHex = (req.header("X-CRC32") || "")
        .toLowerCase()
        .replace(/^0x/, "");

      if (expectedSize < 0 || !expectedCrcHex) {
        return res
          .status(400)
          .json({ s: false, erro: "faltam X-File-Size e/ou X-CRC32" });
      }

      if (arquivoBuffer.length !== expectedSize) {
        console.warn(
          `⚠️ Tamanho incorreto p/ ${filename}. Esperado: ${expectedSize}, Recebido: ${arquivoBuffer.length}`,
        );
        return res.status(422).json({
          s: false,
          erro: "tamanho_incorreto",
          esperado: expectedSize,
          recebido: arquivoBuffer.length,
        });
      }

      const crcRecebido = crc32(arquivoBuffer);
      const crcEsperado = parseInt(expectedCrcHex, 16) >>> 0;

      if (crcRecebido !== crcEsperado) {
        console.warn(`⚠️ CRC incorreto p/ ${filename}`);
        return res.status(422).json({
          s: false,
          erro: "crc_incorreto",
          esperado: expectedCrcHex,
          recebido: crcRecebido.toString(16).padStart(8, "0"),
        });
      }

      if (filename.toLowerCase().endsWith(".gz")) {
        try {
          zlib.gunzipSync(arquivoBuffer);
        } catch (e: any) {
          console.warn(
            `⚠️ Arquivo gzip corrompido: ${filename} - ${e.message}`,
          );
          return res.status(422).json({
            s: false,
            erro: "gzip_invalido",
            detalhe: String(e.message),
          });
        }
      }

      const s3Key = `root/${dlg_id}/${pasta_data}/${filename}`;

      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
        Body: arquivoBuffer,
        ContentType: "application/octet-stream",
      });

      await s3Client.send(command);

      console.log(
        `🚀 [PUT] ${filename} verificado e salvo em ${dlg_id}/${pasta_data}/ (${arquivoBuffer.length} bytes)`,
      );

      res.setHeader("Connection", "close");
      return res.status(201).json({
        s: true,
        arquivo: filename,
        bytes: arquivoBuffer.length,
        crc32: crcRecebido.toString(16).padStart(8, "0"),
      });
    } catch (error) {
      console.error("❌ Erro no PUT S3:", error);
      return res.status(500).json({ e: "erro_interno" });
    }
  },
);

// ============================================================================
// TRATAMENTO GLOBAL DE ERROS & INICIALIZAÇÃO
// ============================================================================

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  if (err.type === "request.aborted") {
    console.warn(
      `⚠️ [Aviso] Upload interrompido (Queda de sinal/Timeout): ${req.originalUrl}`,
    );
    return res.status(400).json({ e: "conexao_abortada" });
  }

  if (err.type === "entity.too.large") {
    console.warn(
      `⚠️ [Aviso] Arquivo excedeu limite na rota: ${req.originalUrl}`,
    );
    return res.status(413).json({ e: "arquivo_muito_grande" });
  }

  console.error(`❌ Erro interno na rota ${req.originalUrl}:`, err.message);
  res.status(500).json({ erro: "Erro interno no servidor" });
});

const PORT = process.env.PORT || 8000;

const server = app.listen(PORT, () => {
  console.log(`Servidor Aspira Cloud rodando na porta ${PORT}`);
});

server.requestTimeout = 300000;
server.headersTimeout = 305000;
server.keepAliveTimeout = 300000;
