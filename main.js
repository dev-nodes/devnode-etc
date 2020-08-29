import Etc from './wrapper'

Etc.run().catch(console.error)
process.on('SIGTERM', () => {
  console.info('SIGTERM signal received.Saving store to .cache folder');
  Etc.save();
  process.exit(0);
});
process.on('SIGINT', () => {
  console.info('SIGINT signal received.Saving store to .cache folder');
  Etc.save();
  process.exit(0);
});
