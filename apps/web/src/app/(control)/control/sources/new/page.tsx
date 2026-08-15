import { Card, CardBody } from '../../../../../features/owner/components/ui/card';
import { BackLink, PageHeader } from '../../../../../features/owner/components/ui/page-header';
import { SourceForm } from '../../../../../features/owner/components/source-form';

export default function NewSourcePage() {
  return (
    <>
      <BackLink href="/control/sources" label="Retour aux sources" />
      <PageHeader
        title="Nouvelle source"
        description="Connectez une playlist M3U, un serveur Xtream Codes ou un portail MAG/Stalker."
      />
      <Card>
        <CardBody>
          <SourceForm />
        </CardBody>
      </Card>
    </>
  );
}
