-- Orgasmus-Anforderung: Foto-Nachweis beim Erfassen erforderlich (sonst freiwillig)
ALTER TABLE "OrgasmusAnforderung" ADD COLUMN "fotoPflicht" BOOLEAN NOT NULL DEFAULT false;
