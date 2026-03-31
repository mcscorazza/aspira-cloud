import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "../public")));

const storage = multer.memoryStorage();
const uploadMulter = multer({ storage: storage });

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
  uploadMulter.single("filename"),
  async (req: Request, res: Response): Promise<any> => {
    try {
      const file = req.file;

      if (!file) {
        return res.status(400).json({ erro: "Nenhum arquivo recebido" });
      }

      const dateNow = new Date().toISOString().split("T")[0];

      const fileName = file.originalname || `datalogger_${Date.now()}.zip`;
      const s3Key = `root/${dateNow}/${fileName}`;

      const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
        Body: file.buffer,
        ContentType: file.mimetype,
      });

      await s3Client.send(command);

      console.log(
        `Sucesso: Arquivo ${fileName} recebido do ESP32 e salvo no S3!`,
      );

      res.status(200).json({
        sucesso: true,
        mensagem: "Arquivo salvo com sucesso",
        caminho: s3Key,
      });
    } catch (error) {
      console.error("Erro ao processar upload do ESP32:", error);
      res.status(500).json({ erro: "Erro interno ao salvar no S3" });
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

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
