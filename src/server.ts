import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import archiver from "archiver";
import { Readable } from "stream";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
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

app.post(
  "/api/upload-esp",
  verificarTokenESP,
  (req: Request, res: Response, next: NextFunction) => {
    uploadMulter.single("filename")(req, res, (err) => {
      if (err) {
        if (
          err.code === "ECONNRESET" ||
          err.message === "Request aborted" ||
          err.message === "Unexpected end of form"
        ) {
          console.log(
            "⚠️ Conexão encerrada pelo ESP32 antes do fechamento total, mas processando...",
          );
          return next();
        }
        return res.status(500).json({ erro: "Erro no upload do arquivo" });
      }
      next();
    });
  },
  async (req: Request, res: Response): Promise<any> => {
    try {
      const arquivo = req.file;
      if (!arquivo)
        return res.status(400).json({ erro: "Arquivo não encontrado" });

      const dataHoje = new Date().toISOString().split("T")[0];
      const nomeArquivo =
        arquivo.originalname || `datalogger_${Date.now()}.zip`;
      const s3Key = `root/${dataHoje}/${nomeArquivo}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: s3Key,
          Body: arquivo.buffer,
          ContentType: arquivo.mimetype,
        }),
      );

      console.log(`✅ Sucesso: ${nomeArquivo} salvo no S3!`);

      res.setHeader("Connection", "close");
      return res.status(200).json({ sucesso: true });
    } catch (error) {
      console.error("❌ Erro S3:", error);
      return res.status(500).json({ erro: "Erro interno" });
    }
  },
);

app.get("/api/url-upload", async (req: Request, res: Response) => {
  try {
    const fileName = req.query.nome_arquivo as string;

    const s3Key = `root/${fileName}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 300,
    });

    res.json({
      url: presignedUrl,
      caminhoFinal: s3Key,
    });
  } catch (error) {
    res.status(500).json({ erro: "Erro ao gerar URL" });
  }
});

app.get("/api/url-download", async (req: Request, res: Response) => {
  try {
    const fileName = req.query.nome_arquivo as string;
    if (!fileName) {
      return res.status(400).json({ erro: "Nome do arquivo eh obrigatorio" });
    }

    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: `root/${fileName}`,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 300,
    });

    res.json({ url: presignedUrl });
  } catch (error) {
    console.error("Erro ao gerar URL de download:", error);
    res.status(500).json({ erro: "Erro interno no servidor" });
  }
});

app.get("/api/listar", async (req: Request, res: Response) => {
  try {
    const prefix = (req.query.prefixo as string) || "root/";

    const command = new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix,
      Delimiter: "/",
    });

    const respostaS3 = await s3Client.send(command);

    const pastas = (respostaS3.CommonPrefixes || []).map((p) => p.Prefix);

    const files = (respostaS3.Contents || [])
      .filter((arquivo) => arquivo.Key !== prefix)
      .map((arquivo) => ({
        chave: arquivo.Key,
        nome: arquivo.Key?.replace(prefix, ""),
        tamanho: arquivo.Size,
        dataModificacao: arquivo.LastModified,
      }));

    res.json({ pastas, arquivos: files, currentPrefix: prefix });
  } catch (error) {
    console.error("Erro ao listar arquivos:", error);
    res.status(500).json({ erro: "Erro ao listar do S3" });
  }
});

app.post(
  "/api/baixar-zip",
  async (req: Request, res: Response): Promise<any> => {
    try {
      const { chaves } = req.body;
      if (!chaves || !Array.isArray(chaves) || chaves.length === 0) {
        return res.status(400).send("Nenhum arquivo selecionado");
      }
      res.attachment(`AC_Files_${Date.now()}.zip`);

      const archive = archiver("zip", { zlib: { level: 5 } });

      archive.on("error", (err) => {
        throw err;
      });
      archive.pipe(res);

      for (const chave of chaves) {
        const command = new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: chave,
        });
        const response = await s3Client.send(command);

        const stream = response.Body as Readable;

        const nomeArquivo = chave.split("/").pop() || chave;

        archive.append(stream, { name: nomeArquivo });
      }

      await archive.finalize();
    } catch (error) {
      console.error("Erro ao gerar ZIP:", error);
      if (!res.headersSent) res.status(500).send("Erro ao gerar ZIP");
    }
  },
);

app.delete("/api/excluir", async (req: Request, res: Response) => {
  try {
    const chaveArquivo = req.query.chave as string;

    if (!chaveArquivo) {
      return res.status(400).json({ erro: "Chave do arquivo é obrigatória" });
    }

    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: chaveArquivo,
    });

    await s3Client.send(command);

    res.json({ sucesso: true, mensagem: "Arquivo excluído com sucesso" });
  } catch (error) {
    console.error("Erro ao excluir arquivo:", error);
    res.status(500).json({ erro: "Erro interno ao tentar excluir do S3" });
  }
});

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

const PORT = process.env.PORT || 8000;

const server = app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

server.requestTimeout = 300000;
server.headersTimeout = 305000;
