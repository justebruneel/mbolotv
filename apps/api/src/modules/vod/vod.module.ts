import { Module } from '@nestjs/common';
import { CommonModule } from '../../common/common.module';
import { AccessModule } from '../access/access.module';
import { MetadataModule } from '../metadata/metadata.module';
import { VodController } from './vod.controller';
import { ExternalController, ExternalGenresController } from './external.controller';
import { VodService } from './vod.service';

// Miroir du catalogue VOD du Worker : les mêmes routes /api/vod*,
// /api/x/titles* et /api/x/genres servies par l'API Nest (déploiement
// auto-hébergé). La lecture directe (proxy HLS et relais résidentiel) reste
// côté Worker.
@Module({
  imports: [AccessModule, CommonModule, MetadataModule],
  controllers: [VodController, ExternalController, ExternalGenresController],
  providers: [VodService],
})
export class VodModule {}
