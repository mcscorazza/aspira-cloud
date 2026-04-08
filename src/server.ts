import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const app = express();

app.use((req, res, next) => {
  res.setHeader("Connection", "close");
  next();
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));
app.use(express.raw({ type: "application/octet-stream", limit: "100mb" }));

const storage = multer.memoryStorage();
const uploadMulter = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

const s3Client = new S3Client({ region: "sa-east-1" });
const BUCKET_NAME = "aspira-cloud";

const verificarTokenESP = (req: Request, res: Response, next: NextFunction) => {
  const token = req.headers["x-api-key"];
  if (token !== "secret-token-2026") {
    return res.status(401).json({ erro: "Acesso não autorizado" });
  }
  next();
};

app.put(
  "/api/upload-esp/:dlg_id/:filename",
  express.raw({ type: "application/octet-stream", limit: "10mb" }),
  verificarTokenESP,
  async (req: Request, res: Response): Promise<any> => {
    req.setTimeout(300000);
    try {
      const { dlg_id, filename } = req.params;
      const arquivoBuffer = req.body;

      if (!arquivoBuffer || arquivoBuffer.length === 0) {
        return res.status(400).json({ erro: "Corpo da requisição vazio" });
      }

      const dataHoje = new Date().toISOString().split("T")[0];
      const s3Key = `root/${dataHoje}/${dlg_id}/${filename}`;

      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
        Body: arquivoBuffer,
        ContentType: "application/octet-stream",
      });

      await s3Client.send(command);

      console.log(
        `🚀 [PUT] ${filename} recebido de ${dlg_id} (${arquivoBuffer.length} bytes)`,
      );

      res.setHeader("Connection", "close");
      return res.status(201).json({ s: true });
    } catch (error) {
      console.error("❌ Erro no PUT S3:", error);
      return res.status(500).json({ e: "erro_interno" });
    }
  },
);

const PORT = process.env.PORT || 8000;

app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (err.type === 'request.aborted') {
        console.warn(`⚠️ [Aviso] Upload interrompido pelo ESP32 (Possível queda de sinal): ${req.originalUrl}`);
        return res.status(400).json({ e: 'conexao_abortada' });
    }

    if (err.type === 'entity.too.large') {
        console.warn(`⚠️ [Aviso] Arquivo excedeu 10MB: ${req.originalUrl}`);
        return res.status(413).json({ e: 'arquivo_muito_grande' });
    }

    console.error(`❌ Erro interno na rota ${req.originalUrl}:`, err.message);
    res.status(500).json({ erro: 'Erro interno no servidor' });
});

const server = app.listen(PORT, () => {
  console.log(`Endpoint ESP rodando na porta ${PORT}`);
});

server.requestTimeout = 300000;
server.headersTimeout = 305000;
server.keepAliveTimeout = 300000;
